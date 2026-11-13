//! Makes model text safe to speak, chunk by chunk: drops markdown marks, list bullets, bracketed text
//! (stage directions, markers), tag-like `<...>`, emoji and URLs, and collapses whitespace. It holds back only what
//! it must: a line-start bullet candidate (`-`, `1.`), a word that could still become a URL (`htt`, `www`), a lone
//! `<` until the next character shows whether it opens a tag, and bracketed text until it closes. Bracketed text
//! that never closes (or runs past `MAX_BRACKET_CHARS`) is released as speech, so an unclosed `(` or `[` never
//! swallows the rest of a reply. A bare `<` or `>` (as in "p99 < 200 ms") is spoken as it is.

const URL_PREFIXES: [&str; 3] = ["https://", "http://", "www."];

/// Bracketed text longer than this is not a stage direction: it is released as speech.
const MAX_BRACKET_CHARS: usize = 80;

#[derive(Debug)]
pub struct SpeechFilter {
    /// Open brackets, innermost last: `(`, `[`, `{` or `<` (tag-like only).
    stack: Vec<char>,
    /// Text inside the outermost bracket, held until it closes (then dropped) or is released.
    bracket: String,
    /// A `<` waiting for the next character: a letter or `/` opens a tag, anything else is plain text.
    lt_pending: bool,
    /// At the start of a line (bullets and headings are only recognised there).
    line_start: bool,
    /// Held characters at a line start that may be a bullet (`-`, `+`, `•`, `>`, `12.`, `3)`).
    line_hold: String,
    /// The current word, held while it could still be a URL.
    word: String,
    /// The current word was released (not a URL); its remaining characters pass straight through.
    word_released: bool,
    /// Inside a URL: drop until whitespace.
    in_url: bool,
    pending_space: bool,
    emitted_any: bool,
    out: String,
}

impl Default for SpeechFilter {
    fn default() -> Self {
        Self::new()
    }
}

impl SpeechFilter {
    pub fn new() -> Self {
        SpeechFilter {
            stack: Vec::new(),
            bracket: String::new(),
            lt_pending: false,
            line_start: true,
            line_hold: String::new(),
            word: String::new(),
            word_released: false,
            in_url: false,
            pending_space: false,
            emitted_any: false,
            out: String::new(),
        }
    }

    /// Feeds one delta; returns the text that is safe to speak now (possibly empty).
    pub fn push(&mut self, delta: &str) -> String {
        for c in delta.chars() {
            self.feed(c);
        }
        std::mem::take(&mut self.out)
    }

    /// Ends the stream: releases held text (a held word that never became a URL, a lone bullet candidate).
    pub fn finish(&mut self) -> String {
        if self.lt_pending {
            self.lt_pending = false;
            self.normal('<');
        }
        if !self.stack.is_empty() {
            self.release_bracket();
        }
        if !self.line_hold.is_empty() {
            let held = std::mem::take(&mut self.line_hold);
            self.line_start = false;
            for c in held.chars() {
                self.normal(c);
            }
        }
        self.end_word();
        self.pending_space = false;
        std::mem::take(&mut self.out)
    }

    fn feed(&mut self, c: char) {
        if self.lt_pending {
            self.lt_pending = false;
            if c.is_ascii_alphabetic() || c == '/' {
                self.open('<');
            } else {
                self.plain('<');
            }
        }
        if !self.stack.is_empty() {
            self.in_bracket(c);
            return;
        }
        match c {
            '(' | '[' | '{' => {
                self.open(c);
                return;
            }
            '<' => {
                self.lt_pending = true;
                return;
            }
            ')' | ']' | '}' => return,
            _ => {}
        }
        self.plain(c);
    }

    fn open(&mut self, c: char) {
        if self.stack.is_empty() {
            self.release_line_hold_if_any();
            self.end_word();
            self.space();
            self.bracket.clear();
        }
        self.stack.push(c);
        self.bracket.push(c);
    }

    fn in_bracket(&mut self, c: char) {
        self.bracket.push(c);
        let top = *self.stack.last().unwrap_or(&'(');
        let closes = matches!((top, c), ('(', ')') | ('[', ']') | ('{', '}') | ('<', '>'));
        if closes {
            self.stack.pop();
            if self.stack.is_empty() {
                self.bracket.clear();
            }
            return;
        }
        if matches!(c, '(' | '[' | '{') {
            self.stack.push(c);
        }
        if self.bracket.chars().count() > MAX_BRACKET_CHARS {
            self.release_bracket();
        }
    }

    /// The bracket never closed in time: speak its text, without the bracket characters.
    fn release_bracket(&mut self) {
        self.stack.clear();
        let held = std::mem::take(&mut self.bracket);
        for h in held.chars() {
            if !matches!(h, '(' | ')' | '[' | ']' | '{' | '}' | '<' | '>') {
                self.plain(h);
            }
        }
    }

    fn release_line_hold_if_any(&mut self) {
        if !self.line_hold.is_empty() {
            self.release_line_hold();
        }
    }

    fn plain(&mut self, c: char) {
        if c == '\n' || c == '\r' {
            self.release_line_hold();
            self.end_word();
            self.space();
            self.line_start = true;
            return;
        }
        if self.line_start {
            if self.line_hold.is_empty() {
                match c {
                    ' ' | '\t' | '#' => return,
                    '-' | '+' | '•' | '>' | '*' => {
                        self.line_hold.push(c);
                        return;
                    }
                    d if d.is_ascii_digit() => {
                        self.line_hold.push(c);
                        return;
                    }
                    _ => self.line_start = false,
                }
            } else {
                let digits = self.line_hold.chars().all(|h| h.is_ascii_digit());
                if digits && c.is_ascii_digit() {
                    self.line_hold.push(c);
                    return;
                }
                if digits && (c == '.' || c == ')') {
                    self.line_hold.push(c);
                    return;
                }
                if c == ' ' || c == '\t' {
                    let numbered = self.line_hold.len() > 1
                        && self.line_hold.ends_with(['.', ')'])
                        && self.line_hold[..self.line_hold.len() - 1]
                            .chars()
                            .all(|h| h.is_ascii_digit());
                    let marker = self.line_hold.chars().count() == 1
                        && matches!(
                            self.line_hold.chars().next(),
                            Some('-' | '+' | '•' | '>' | '*')
                        );
                    if numbered || marker {
                        self.line_hold.clear();
                        self.line_start = false;
                        self.space();
                        return;
                    }
                }
                self.release_line_hold();
            }
        }
        self.normal(c);
    }

    fn release_line_hold(&mut self) {
        self.line_start = false;
        let held = std::mem::take(&mut self.line_hold);
        for h in held.chars() {
            self.normal(h);
        }
    }

    fn normal(&mut self, c: char) {
        if matches!(c, '*' | '#' | '`' | '~' | '|') || is_emoji(c) {
            return;
        }
        // Snake case and arrows: a word break, never a spoken symbol.
        let c = if c == '_' || ('\u{2190}'..='\u{21FF}').contains(&c) {
            ' '
        } else {
            c
        };
        if c.is_whitespace() {
            self.end_word();
            self.space();
            return;
        }
        if self.in_url {
            return;
        }
        if self.word_released {
            self.emit_char(c);
            return;
        }
        self.word.push(c);
        let lower = self.word.to_ascii_lowercase();
        if URL_PREFIXES.iter().any(|p| lower.starts_with(p)) {
            self.in_url = true;
            self.word.clear();
        } else if !URL_PREFIXES.iter().any(|p| p.starts_with(&lower)) {
            let word = std::mem::take(&mut self.word);
            self.word_released = true;
            for w in word.chars() {
                self.emit_char(w);
            }
        }
    }

    fn end_word(&mut self) {
        if !self.word.is_empty() {
            let word = std::mem::take(&mut self.word);
            for w in word.chars() {
                self.emit_char(w);
            }
        }
        self.word_released = false;
        self.in_url = false;
    }

    fn space(&mut self) {
        if self.emitted_any {
            self.pending_space = true;
        }
    }

    fn emit_char(&mut self, c: char) {
        if self.pending_space {
            self.pending_space = false;
            if !matches!(c, '.' | ',' | '!' | '?' | ';' | ':') {
                self.out.push(' ');
            }
        }
        self.out.push(c);
        self.emitted_any = true;
    }
}

fn is_emoji(c: char) -> bool {
    let u = c as u32;
    matches!(u,
        0x1F000..=0x1FAFF   // pictographs, emoticons, transport, flags, symbols
        | 0x2600..=0x27BF   // misc symbols, dingbats
        | 0x2B00..=0x2BFF   // arrows and stars
        | 0x2300..=0x23FF   // technical (watch, hourglass)
        | 0xFE00..=0xFE0F   // variation selectors
        | 0x200D            // zero width joiner
        | 0xE0020..=0xE007F // tags
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(chunks: &[&str]) -> String {
        let mut f = SpeechFilter::new();
        let mut out: String = chunks.iter().map(|c| f.push(c)).collect();
        out.push_str(&f.finish());
        out
    }

    #[test]
    fn plain_text_passes_through_immediately() {
        let mut f = SpeechFilter::new();
        assert_eq!(f.push("Okay. So"), "Okay. So");
        assert_eq!(f.push(" what"), " what");
        assert_eq!(f.finish(), "");
    }

    #[test]
    fn keeps_hyphens_inside_words_and_numbers() {
        assert_eq!(
            run(&["A well-known trade-off, ", "-5 degrees? 10 users."]),
            "A well-known trade-off, -5 degrees? 10 users."
        );
    }

    #[test]
    fn unclosed_bracket_is_released_as_speech() {
        assert_eq!(run(&["Okay. (thinking"]), "Okay. thinking");
        assert_eq!(
            run(&[
                "So [the cache sits in front of the database and every read goes through it first, ",
                "then the shard map]"
            ]),
            "So the cache sits in front of the database and every read goes through it first, then the shard map"
        );
    }

    #[test]
    fn comparisons_are_not_brackets() {
        assert_eq!(
            run(&["Keep p99 < 200 ms, then shard."]),
            "Keep p99 < 200 ms, then shard."
        );
        assert_eq!(
            run(&["If load > 10", "k, we scale."]),
            "If load > 10k, we scale."
        );
        assert_eq!(run(&["a <", " b and c"]), "a < b and c");
    }

    #[test]
    fn tags_and_closed_brackets_are_dropped() {
        assert_eq!(
            run(&["<emphasis>Okay.</emp", "hasis> (nods) Go on."]),
            "Okay. Go on."
        );
    }

    #[test]
    fn underscores_and_arrows_become_spaces() {
        assert_eq!(
            run(&["The user_id goes A \u{2192} B."]),
            "The user id goes A B."
        );
    }

    #[test]
    fn markers_are_dropped() {
        assert_eq!(run(&["[event: start] Hi, I'm Daniel."]), "Hi, I'm Daniel.");
    }
}
