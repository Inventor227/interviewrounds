//! Loads the `content/` folder: rounds, personas, rubrics, question banks, meeting templates and prompts.
//! Rounds and personas are typed (`content/schema/*.schema.json`); the rest stay JSON until their tasks need types.

use std::collections::BTreeMap;
use std::path::Path;

use anyhow::{Context, bail};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Marker in `house-rules.md` between the cached system part and the per-turn note template.
pub const TURN_NOTE_MARKER: &str = "<!-- turn-note -->";

#[derive(Clone, Debug, Default)]
pub struct Catalog {
    pub rounds: BTreeMap<String, RoundConfig>,
    pub personas: BTreeMap<String, Persona>,
    pub rubrics: BTreeMap<String, Value>,
    pub banks: BTreeMap<String, Value>,
    pub templates: BTreeMap<String, Value>,
    /// Prompt files by file stem, comments stripped. A file with the turn-note marker is split in two:
    /// `<stem>` (before) and `<stem>.turn-note` (after).
    pub prompts: BTreeMap<String, String>,
    pub voices: Option<Value>,
}

/// `content/schema/round.schema.json`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RoundConfig {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub summary: Option<String>,
    pub role: String,
    pub round_type: String,
    pub length: String,
    pub target_minutes: f64,
    pub hard_stop_minutes: f64,
    pub silence_wait_seconds: u32,
    pub interrupt_after_seconds: u32,
    pub panel: PanelConfig,
    pub phases: Vec<Phase>,
    pub rubric_id: String,
    pub question_pool: String,
    pub hands: String,
    #[serde(default)]
    pub board_kit: Option<String>,
    #[serde(default)]
    pub short_version: Option<String>,
    #[serde(default)]
    pub full_version: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PanelConfig {
    pub lead: String,
    #[serde(default)]
    pub second: Option<String>,
    #[serde(default)]
    pub second_enters_phase: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Phase {
    pub id: String,
    #[serde(default)]
    pub title: Option<String>,
    pub minutes: f64,
    pub goal: String,
    #[serde(default)]
    pub must_cover: Vec<String>,
    #[serde(default)]
    pub uses_whiteboard: bool,
}

/// `content/schema/persona.schema.json`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Persona {
    pub id: String,
    pub display_name: String,
    pub title: String,
    pub avatar_id: String,
    pub voice_id: String,
    pub style: String,
    pub warmth: u8,
    pub pushback: u8,
    pub hint_generosity: u8,
    #[serde(default)]
    pub interrupts_after_seconds: Option<u32>,
    #[serde(default)]
    pub behaviour: Option<String>,
    #[serde(default)]
    pub cut_in_keywords: Vec<String>,
    #[serde(default)]
    pub speech_habits: Vec<String>,
    #[serde(default)]
    pub never: Vec<String>,
}

impl Catalog {
    /// Reads every known subfolder of `dir`. Missing folders are empty; a file that does not parse is an error
    /// naming the file.
    pub fn load(dir: &Path) -> anyhow::Result<Catalog> {
        if !dir.is_dir() {
            bail!("content folder {} does not exist", dir.display());
        }
        let mut cat = Catalog::default();
        for (path, v) in json_files(&dir.join("rounds"))? {
            let round: RoundConfig = serde_json::from_value(v)
                .with_context(|| format!("parsing round {}", path.display()))?;
            cat.rounds.insert(round.id.clone(), round);
        }
        for (path, v) in json_files(&dir.join("personas"))? {
            let persona: Persona = serde_json::from_value(v)
                .with_context(|| format!("parsing persona {}", path.display()))?;
            cat.personas.insert(persona.id.clone(), persona);
        }
        for (sub, map) in [
            ("rubrics", &mut cat.rubrics),
            ("banks", &mut cat.banks),
            ("meeting-templates", &mut cat.templates),
        ] {
            for (path, v) in json_files(&dir.join(sub))? {
                let id = v
                    .get("id")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .unwrap_or_else(|| stem(&path));
                map.insert(id, v);
            }
        }
        let prompts = dir.join("prompts");
        if prompts.is_dir() {
            for path in sorted_files(&prompts, "md")? {
                let raw = std::fs::read_to_string(&path)
                    .with_context(|| format!("reading {}", path.display()))?;
                let name = stem(&path);
                match raw.split_once(TURN_NOTE_MARKER) {
                    Some((head, note)) => {
                        cat.prompts.insert(name.clone(), strip_comments(head));
                        cat.prompts
                            .insert(format!("{name}.turn-note"), strip_comments(note));
                    }
                    None => {
                        cat.prompts.insert(name, strip_comments(&raw));
                    }
                }
            }
        }
        let voices = dir.join("voices.json");
        if voices.is_file() {
            let raw = std::fs::read_to_string(&voices)?;
            cat.voices = Some(
                serde_json::from_str(&raw)
                    .with_context(|| format!("parsing {}", voices.display()))?,
            );
        }
        Ok(cat)
    }

    pub fn round(&self, id: &str) -> Option<&RoundConfig> {
        self.rounds.get(id)
    }

    pub fn persona(&self, id: &str) -> Option<&Persona> {
        self.personas.get(id)
    }

    pub fn prompt(&self, name: &str) -> Option<&str> {
        self.prompts.get(name).map(String::as_str)
    }

    /// A question card from a bank: the one with `card_id`, or the first card when `card_id` is None.
    pub fn bank_card(&self, bank_id: &str, card_id: Option<&str>) -> Option<&Value> {
        let cards = self.banks.get(bank_id)?.get("cards")?.as_array()?;
        match card_id {
            Some(id) => cards
                .iter()
                .find(|c| c.get("id").and_then(Value::as_str) == Some(id)),
            None => cards.first(),
        }
    }

    /// Fish voice id for a persona, from `voices.json` (`voices.<persona.voice_id>.fish_id`).
    pub fn fish_voice_id(&self, persona: &Persona) -> Option<&str> {
        self.voices
            .as_ref()?
            .get("voices")?
            .get(&persona.voice_id)?
            .get("fish_id")?
            .as_str()
    }
}

fn stem(path: &Path) -> String {
    path.file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default()
}

fn sorted_files(dir: &Path, ext: &str) -> anyhow::Result<Vec<std::path::PathBuf>> {
    let mut files = Vec::new();
    for entry in std::fs::read_dir(dir).with_context(|| format!("listing {}", dir.display()))? {
        let path = entry?.path();
        if path.is_file() && path.extension().is_some_and(|e| e == ext) {
            files.push(path);
        }
    }
    files.sort();
    Ok(files)
}

fn json_files(dir: &Path) -> anyhow::Result<Vec<(std::path::PathBuf, Value)>> {
    if !dir.is_dir() {
        return Ok(Vec::new());
    }
    sorted_files(dir, "json")?
        .into_iter()
        .map(|path| {
            let raw = std::fs::read_to_string(&path)
                .with_context(|| format!("reading {}", path.display()))?;
            let v = serde_json::from_str(&raw)
                .with_context(|| format!("parsing {}", path.display()))?;
            Ok((path, v))
        })
        .collect()
}

/// Removes `<!-- ... -->` comments and trims the result.
pub fn strip_comments(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find("<!--") {
        out.push_str(&rest[..start]);
        match rest[start..].find("-->") {
            Some(end) => rest = &rest[start + end + 3..],
            None => {
                rest = "";
                break;
            }
        }
    }
    out.push_str(rest);
    out.trim().to_string()
}

/// The body of the `## <key>` section of a prompt file (up to the next `## ` heading), trimmed.
pub fn section<'a>(text: &'a str, key: &str) -> Option<&'a str> {
    let mut start = None;
    let mut offset = 0;
    for line in text.split_inclusive('\n') {
        let heading = line.strip_prefix("## ").map(str::trim);
        match (start, heading) {
            (None, Some(h)) if h == key => start = Some(offset + line.len()),
            (Some(s), Some(_)) => return Some(text[s..offset].trim()),
            _ => {}
        }
        offset += line.len();
    }
    start.map(|s| text[s..].trim())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_comments_and_finds_sections() {
        assert_eq!(strip_comments("<!-- a -->x<!-- b\nc -->y"), "xy");
        let text = "## junior\nJ1\nJ2\n\n## mid\nM\n";
        assert_eq!(section(text, "junior"), Some("J1\nJ2"));
        assert_eq!(section(text, "mid"), Some("M"));
        assert_eq!(section(text, "staff"), None);
    }
}
