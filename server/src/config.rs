//! Runtime configuration, read once from the environment at startup.

use std::fmt;
use std::path::PathBuf;

/// Which spending phase the app is in. Caps and guest limits depend on it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UsagePhase {
    Build,
    Judging,
    After,
}

impl UsagePhase {
    pub fn as_str(self) -> &'static str {
        match self {
            UsagePhase::Build => "build",
            UsagePhase::Judging => "judging",
            UsagePhase::After => "after",
        }
    }
}

/// How a panel of AI people is voiced: one Fish session at a time that swaps on hand-over, or all joined at start.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PanelMode {
    Swap,
    Joined,
}

impl PanelMode {
    pub fn as_str(self) -> &'static str {
        match self {
            PanelMode::Swap => "swap",
            PanelMode::Joined => "joined",
        }
    }
}

#[derive(Debug, thiserror::Error, PartialEq)]
pub enum ConfigError {
    #[error("missing required environment variable(s): {}", .0.join(", "))]
    Missing(Vec<&'static str>),
    #[error("invalid value for environment variable {var}: {reason}")]
    Invalid { var: &'static str, reason: String },
}

/// All settings the server needs. Secret fields are redacted in `Debug`.
#[derive(Clone)]
pub struct Config {
    pub port: u16,
    pub database_url: String,
    pub app_origin: String,
    /// Origin of public links such as shared scorecards (`PUBLIC_BASE_URL`, default `APP_ORIGIN`).
    pub public_base_url: String,
    pub content_dir: PathBuf,
    pub public_dir: PathBuf,
    pub data_dir: PathBuf,
    pub anthropic_api_key: String,
    pub anthropic_workspace_id: String,
    pub fish_api_key: String,
    pub fish_agent_id: String,
    pub fish_llm_secret: String,
    pub live_model: String,
    pub fast_model: String,
    /// `LIVE_FALLBACK_MODEL`: the second attempt of a fast call whose model is unavailable (overloaded, 5xx, 429,
    /// no answer in time). Never the live or fast model, so an overload of one model family is ridden out.
    pub live_fallback_model: String,
    pub scoring_model: String,
    /// `output_config.effort` for live turns (`LIVE_EFFORT`, default `low`).
    pub live_effort: String,
    pub usage_phase: UsagePhase,
    pub fish_build_cap_usd: f64,
    pub judge_cap_usd: f64,
    pub fish_rate_per_min: f64,
    /// Model spend per UTC day across everyone (`MODEL_DAILY_CAP_USD`, default 40); new sessions stop beyond it.
    pub model_daily_cap_usd: f64,
    /// Fish spend made outside this server's ledger during the build (spikes), counted against the build cap.
    pub fish_build_spent_usd: f64,
    /// `PANEL_MODE`: `swap` (default) or `joined`.
    pub panel_mode: PanelMode,
    pub google_client_id: Option<String>,
    pub google_client_secret: Option<String>,
    pub dev_key: String,
    /// Extra origins allowed in the CSP `connect-src` (space separated).
    pub csp_connect_extra: String,
}

pub const DEFAULT_MODEL: &str = "claude-opus-5-5";
/// Live voice and fast calls: the most capable model under the voice latency target (research/09-voice-spike.md).
pub const DEFAULT_LIVE_MODEL: &str = "claude-sonnet-5-5";
/// The fallback for live and fast calls when their model is unavailable.
pub const DEFAULT_LIVE_FALLBACK_MODEL: &str = "claude-haiku-5-5";
pub const DEFAULT_CSP_CONNECT_EXTRA: &str =
    "https://*.fish.audio wss://*.fish.audio https://*.livekit.cloud wss://*.livekit.cloud";

impl Config {
    /// Reads the process environment. Fails with every missing required variable named.
    pub fn from_env() -> Result<Config, ConfigError> {
        Config::from_lookup(|key| std::env::var(key).ok())
    }

    /// Builds a config from any key lookup (the environment, or a map in tests).
    /// Empty values count as missing.
    pub fn from_lookup<F>(lookup: F) -> Result<Config, ConfigError>
    where
        F: Fn(&str) -> Option<String>,
    {
        let get = |key: &str| {
            lookup(key)
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty())
        };

        let mut missing = Vec::new();
        let mut required = |key: &'static str| match get(key) {
            Some(v) => v,
            None => {
                missing.push(key);
                String::new()
            }
        };

        let database_url = required("DATABASE_URL");
        let app_origin = required("APP_ORIGIN");
        let anthropic_api_key = required("ANTHROPIC_API_KEY");
        let anthropic_workspace_id = required("ANTHROPIC_WORKSPACE_ID");
        let fish_api_key = required("FISH_AUDIO_API_KEY");
        let fish_agent_id = required("FISH_AGENT_ID");
        let fish_llm_secret = required("FISH_LLM_SECRET");
        let dev_key = required("DEV_KEY");

        if !missing.is_empty() {
            return Err(ConfigError::Missing(missing));
        }

        if !(app_origin.starts_with("https://") || app_origin.starts_with("http://")) {
            return Err(ConfigError::Invalid {
                var: "APP_ORIGIN",
                reason: "must start with https:// or http://".into(),
            });
        }
        let app_origin = app_origin.trim_end_matches('/').to_string();
        let public_base_url = get("PUBLIC_BASE_URL").unwrap_or_else(|| app_origin.clone());
        if !(public_base_url.starts_with("https://") || public_base_url.starts_with("http://")) {
            return Err(ConfigError::Invalid {
                var: "PUBLIC_BASE_URL",
                reason: "must start with https:// or http://".into(),
            });
        }
        let public_base_url = public_base_url.trim_end_matches('/').to_string();

        let usage_phase = match get("USAGE_PHASE").as_deref().unwrap_or("build") {
            "build" => UsagePhase::Build,
            "judging" => UsagePhase::Judging,
            "after" => UsagePhase::After,
            other => {
                return Err(ConfigError::Invalid {
                    var: "USAGE_PHASE",
                    reason: format!("expected build, judging or after, got {other:?}"),
                });
            }
        };

        let live_effort = get("LIVE_EFFORT").unwrap_or_else(|| "low".into());
        if !["low", "medium", "high", "xhigh", "max"].contains(&live_effort.as_str()) {
            return Err(ConfigError::Invalid {
                var: "LIVE_EFFORT",
                reason: format!("expected low, medium, high, xhigh or max, got {live_effort:?}"),
            });
        }

        let panel_mode = match get("PANEL_MODE").as_deref().unwrap_or("swap") {
            "swap" => PanelMode::Swap,
            "joined" => PanelMode::Joined,
            other => {
                return Err(ConfigError::Invalid {
                    var: "PANEL_MODE",
                    reason: format!("expected swap or joined, got {other:?}"),
                });
            }
        };

        let csp_connect_extra =
            get("CSP_CONNECT_EXTRA").unwrap_or_else(|| DEFAULT_CSP_CONNECT_EXTRA.into());
        if let Some(bad) = csp_connect_extra
            .split_whitespace()
            .find(|s| !is_csp_source(s))
        {
            return Err(ConfigError::Invalid {
                var: "CSP_CONNECT_EXTRA",
                reason: format!(
                    "{bad:?} is not a CSP source (expected scheme://host, space separated)"
                ),
            });
        }

        let port = parse_or(&get, "PORT", 8080u16)?;
        let fish_build_cap_usd = parse_or(&get, "FISH_BUILD_CAP_USD", 14.0f64)?;
        let judge_cap_usd = parse_or(&get, "JUDGE_CAP_USD", 100.0f64)?;
        let fish_rate_per_min = parse_or(&get, "FISH_RATE_PER_MIN", 0.07f64)?;
        let model_daily_cap_usd = parse_or(&get, "MODEL_DAILY_CAP_USD", 40.0f64)?;
        let fish_build_spent_usd = parse_or(&get, "FISH_BUILD_SPENT_USD", 0.0f64)?;
        for (var, value) in [
            ("FISH_BUILD_SPENT_USD", fish_build_spent_usd),
            ("FISH_BUILD_CAP_USD", fish_build_cap_usd),
            ("JUDGE_CAP_USD", judge_cap_usd),
            ("FISH_RATE_PER_MIN", fish_rate_per_min),
            ("MODEL_DAILY_CAP_USD", model_daily_cap_usd),
        ] {
            if !value.is_finite() || value < 0.0 {
                return Err(ConfigError::Invalid {
                    var,
                    reason: "must be a non-negative number".into(),
                });
            }
        }

        Ok(Config {
            port,
            database_url,
            app_origin,
            public_base_url,
            content_dir: get("CONTENT_DIR")
                .unwrap_or_else(|| "content".into())
                .into(),
            public_dir: get("PUBLIC_DIR").unwrap_or_else(|| "public".into()).into(),
            data_dir: get("DATA_DIR").unwrap_or_else(|| "data".into()).into(),
            anthropic_api_key,
            anthropic_workspace_id,
            fish_api_key,
            fish_agent_id,
            fish_llm_secret,
            live_model: get("LIVE_MODEL").unwrap_or_else(|| DEFAULT_LIVE_MODEL.into()),
            fast_model: get("FAST_MODEL").unwrap_or_else(|| DEFAULT_LIVE_MODEL.into()),
            live_fallback_model: get("LIVE_FALLBACK_MODEL")
                .unwrap_or_else(|| DEFAULT_LIVE_FALLBACK_MODEL.into()),
            scoring_model: get("SCORING_MODEL").unwrap_or_else(|| DEFAULT_MODEL.into()),
            live_effort,
            usage_phase,
            fish_build_cap_usd,
            judge_cap_usd,
            fish_rate_per_min,
            model_daily_cap_usd,
            fish_build_spent_usd,
            panel_mode,
            google_client_id: get("GOOGLE_CLIENT_ID"),
            google_client_secret: get("GOOGLE_CLIENT_SECRET"),
            dev_key,
            csp_connect_extra,
        })
    }

    /// Host part of `app_origin` (for the websocket origin in the CSP).
    pub fn app_host(&self) -> &str {
        self.app_origin
            .split_once("://")
            .map(|(_, rest)| rest)
            .unwrap_or(&self.app_origin)
    }
}

/// A CSP host source: `scheme://host[:port][/path]` with an optional `*.` host wildcard, or a bare `scheme:`.
/// Anything that could end the directive or inject another (`;`, `,`, quotes, spaces) is refused.
fn is_csp_source(s: &str) -> bool {
    let allowed = |c: char| c.is_ascii_alphanumeric() || "-._~:/*%".contains(c);
    if !s.chars().all(allowed) {
        return false;
    }
    let Some((scheme, rest)) = s.split_once("://") else {
        // `data:`, `blob:`, `https:` and the like.
        return s.ends_with(':')
            && s.len() > 1
            && s[..s.len() - 1]
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "+-.".contains(c));
    };
    let scheme_ok = !scheme.is_empty()
        && scheme
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphabetic())
        && scheme
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "+-.".contains(c));
    let host = rest.split('/').next().unwrap_or("");
    let host = host.rsplit_once(':').map_or(host, |(h, port)| {
        if port == "*" || (!port.is_empty() && port.chars().all(|c| c.is_ascii_digit())) {
            h
        } else {
            ""
        }
    });
    let host = host.strip_prefix("*.").unwrap_or(host);
    let host_ok = host == "*"
        || (!host.is_empty()
            && host.split('.').all(|l| {
                !l.is_empty() && l.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
            }));
    scheme_ok && host_ok
}

fn parse_or<T, G>(get: &G, var: &'static str, default: T) -> Result<T, ConfigError>
where
    T: std::str::FromStr,
    T::Err: fmt::Display,
    G: Fn(&str) -> Option<String>,
{
    match get(var) {
        None => Ok(default),
        Some(raw) => raw.parse::<T>().map_err(|e| ConfigError::Invalid {
            var,
            reason: e.to_string(),
        }),
    }
}

const REDACTED: &str = "<redacted>";

impl fmt::Debug for Config {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Config")
            .field("port", &self.port)
            .field("database_url", &REDACTED)
            .field("app_origin", &self.app_origin)
            .field("public_base_url", &self.public_base_url)
            .field("content_dir", &self.content_dir)
            .field("public_dir", &self.public_dir)
            .field("data_dir", &self.data_dir)
            .field("anthropic_api_key", &REDACTED)
            .field("anthropic_workspace_id", &REDACTED)
            .field("fish_api_key", &REDACTED)
            .field("fish_agent_id", &self.fish_agent_id)
            .field("fish_llm_secret", &REDACTED)
            .field("live_model", &self.live_model)
            .field("fast_model", &self.fast_model)
            .field("live_fallback_model", &self.live_fallback_model)
            .field("scoring_model", &self.scoring_model)
            .field("live_effort", &self.live_effort)
            .field("usage_phase", &self.usage_phase)
            .field("fish_build_cap_usd", &self.fish_build_cap_usd)
            .field("judge_cap_usd", &self.judge_cap_usd)
            .field("fish_rate_per_min", &self.fish_rate_per_min)
            .field("model_daily_cap_usd", &self.model_daily_cap_usd)
            .field("fish_build_spent_usd", &self.fish_build_spent_usd)
            .field("panel_mode", &self.panel_mode)
            .field("google_client_id", &self.google_client_id)
            .field(
                "google_client_secret",
                &self.google_client_secret.as_ref().map(|_| REDACTED),
            )
            .field("dev_key", &REDACTED)
            .field("csp_connect_extra", &self.csp_connect_extra)
            .finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn base() -> HashMap<&'static str, String> {
        [
            ("DATABASE_URL", "postgres://u:SECRET-PW@db:5432/x"),
            ("APP_ORIGIN", "https://rounds.dijmo.com/"),
            ("ANTHROPIC_API_KEY", "SECRET-ANTHROPIC"),
            ("ANTHROPIC_WORKSPACE_ID", "SECRET-WORKSPACE"),
            ("FISH_AUDIO_API_KEY", "SECRET-FISH"),
            ("FISH_AGENT_ID", "agent1"),
            ("FISH_LLM_SECRET", "SECRET-LLM"),
            ("DEV_KEY", "SECRET-DEV"),
            ("GOOGLE_CLIENT_SECRET", "SECRET-GOOGLE"),
        ]
        .into_iter()
        .map(|(k, v)| (k, v.to_string()))
        .collect()
    }

    fn load(env: &HashMap<&'static str, String>) -> Result<Config, ConfigError> {
        Config::from_lookup(|k| env.get(k).cloned())
    }

    #[test]
    fn defaults_apply_when_optional_vars_are_absent() {
        let cfg = load(&base()).unwrap();
        assert_eq!(cfg.port, 8080);
        assert_eq!(cfg.app_origin, "https://rounds.dijmo.com");
        assert_eq!(cfg.app_host(), "rounds.dijmo.com");
        assert_eq!(cfg.usage_phase, UsagePhase::Build);
        assert_eq!(cfg.fish_build_cap_usd, 14.0);
        assert_eq!(cfg.judge_cap_usd, 100.0);
        assert_eq!(cfg.fish_rate_per_min, 0.07);
        assert_eq!(cfg.model_daily_cap_usd, 40.0);
        assert_eq!(cfg.live_model, "claude-sonnet-5-5");
        assert_eq!(cfg.fast_model, "claude-sonnet-5-5");
        assert_eq!(cfg.live_fallback_model, "claude-haiku-5-5");
        assert_eq!(cfg.scoring_model, "claude-opus-5-5");
        assert_eq!(cfg.live_effort, "low");
        assert_eq!(cfg.google_client_id, None);
        assert_eq!(cfg.public_dir, PathBuf::from("public"));
    }

    #[test]
    fn missing_required_vars_are_all_named() {
        let mut env = base();
        env.remove("DATABASE_URL");
        env.insert("FISH_LLM_SECRET", "  ".into());
        let err = load(&env).unwrap_err();
        assert_eq!(
            err,
            ConfigError::Missing(vec!["DATABASE_URL", "FISH_LLM_SECRET"])
        );
        let msg = err.to_string();
        assert!(
            msg.contains("DATABASE_URL") && msg.contains("FISH_LLM_SECRET"),
            "{msg}"
        );
    }

    #[test]
    fn bad_values_name_the_variable() {
        let mut env = base();
        env.insert("USAGE_PHASE", "launch".into());
        assert!(matches!(
            load(&env),
            Err(ConfigError::Invalid {
                var: "USAGE_PHASE",
                ..
            })
        ));

        let mut env = base();
        env.insert("JUDGE_CAP_USD", "lots".into());
        assert!(matches!(
            load(&env),
            Err(ConfigError::Invalid {
                var: "JUDGE_CAP_USD",
                ..
            })
        ));

        let mut env = base();
        env.insert("LIVE_EFFORT", "none".into());
        assert!(matches!(
            load(&env),
            Err(ConfigError::Invalid {
                var: "LIVE_EFFORT",
                ..
            })
        ));

        let mut env = base();
        env.insert("FISH_RATE_PER_MIN", "-1".into());
        assert!(matches!(
            load(&env),
            Err(ConfigError::Invalid {
                var: "FISH_RATE_PER_MIN",
                ..
            })
        ));

        let mut env = base();
        env.insert("APP_ORIGIN", "rounds.dijmo.com".into());
        assert!(matches!(
            load(&env),
            Err(ConfigError::Invalid {
                var: "APP_ORIGIN",
                ..
            })
        ));
    }

    #[test]
    fn csp_connect_extra_must_be_valid_sources() {
        let mut env = base();
        env.insert(
            "CSP_CONNECT_EXTRA",
            "https://*.fish.audio wss://a.livekit.cloud:443 https://x.test/p data:".into(),
        );
        assert!(load(&env).is_ok());
        for bad in [
            "https://a.test; script-src *",
            "'unsafe-inline'",
            "https://a.test,https://b.test",
            "fish.audio",
            "https://",
            "https://a..b",
        ] {
            let mut env = base();
            env.insert("CSP_CONNECT_EXTRA", bad.into());
            assert!(
                matches!(
                    load(&env),
                    Err(ConfigError::Invalid {
                        var: "CSP_CONNECT_EXTRA",
                        ..
                    })
                ),
                "{bad} was accepted"
            );
        }
    }

    #[test]
    fn panel_mode_defaults_to_swap() {
        assert_eq!(load(&base()).unwrap().panel_mode, PanelMode::Swap);
        let mut env = base();
        env.insert("PANEL_MODE", "joined".into());
        assert_eq!(load(&env).unwrap().panel_mode, PanelMode::Joined);
        env.insert("PANEL_MODE", "both".into());
        assert!(load(&env).is_err());
    }

    #[test]
    fn overrides_are_read() {
        let mut env = base();
        env.insert("USAGE_PHASE", "judging".into());
        env.insert("LIVE_MODEL", "claude-sonnet-5-5".into());
        env.insert("LIVE_EFFORT", "medium".into());
        env.insert("GOOGLE_CLIENT_ID", "gid".into());
        env.insert("PORT", "9000".into());
        let cfg = load(&env).unwrap();
        assert_eq!(cfg.usage_phase, UsagePhase::Judging);
        assert_eq!(cfg.live_model, "claude-sonnet-5-5");
        assert_eq!(cfg.live_effort, "medium");
        assert_eq!(cfg.google_client_id.as_deref(), Some("gid"));
        assert_eq!(cfg.port, 9000);
    }

    #[test]
    fn debug_output_hides_secrets() {
        let cfg = load(&base()).unwrap();
        let shown = format!("{cfg:?}");
        assert!(!shown.contains("SECRET"), "a secret leaked in {shown}");
    }
}
