//! Makes model text safe to speak, chunk by chunk: drops markdown marks, list bullets, bracketed text
//! (stage directions, markers), emoji and URLs, and collapses whitespace. It holds back only what it must:
//! a line-start bullet candidate (`-`, `1.`) and a word that could still become a URL (`htt`, `www`).

const URL_PREFIXES: [&str; 3] = ["https://", "http://", "www."];

#[derive(Debug)]
pub struct SpeechFilter {
    /// Nesting depth inside (), [], {} or <>.
    depth: u32,
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
            depth: 0,
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
        if self.depth > 0 {
            if is_open(c) {
                self.depth += 1;
            } else if is_close(c) {
                self.depth -= 1;
            }
            return;
        }
        if is_open(c) {
            self.end_word();
            self.space();
            self.depth = 1;
            return;
        }
        if is_close(c) {
            return;
        }
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

fn is_open(c: char) -> bool {
    matches!(c, '(' | '[' | '{' | '<')
}

fn is_close(c: char) -> bool {
    matches!(c, ')' | ']' | '}' | '>')
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
    fn unclosed_bracket_drops_the_rest() {
        assert_eq!(run(&["Okay. (thinking"]), "Okay.");
    }

    #[test]
    fn markers_are_dropped() {
        assert_eq!(run(&["[event: start] Hi, I'm Daniel."]), "Hi, I'm Daniel.");
    }
}
