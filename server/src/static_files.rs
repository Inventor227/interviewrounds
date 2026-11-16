//! Content versions of public files.
//!
//! The web app asks for its big public files (avatar models, clip libraries, the texture transcoder) as
//! `/path?v=<version>`, where the version is the first 16 hex digits of the file's SHA-256, worked out at build time
//! (`web/staticVersions.ts`). Such a response may be cached for a year, but only when the version is the one of the
//! file this server has: a page from another build asking for its own version gets today's file, revalidated, and
//! never kept for good under a name that means other bytes.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::SystemTime;

use sha2::{Digest, Sha256};

/// Hex digits of the SHA-256 in a version.
pub const VERSION_LEN: usize = 16;

/// The version a file's bytes have.
pub fn version_of(bytes: &[u8]) -> String {
    let mut h = hex::encode(Sha256::digest(bytes));
    h.truncate(VERSION_LEN);
    h
}

/// The `v` parameter of a query, when it looks like a version.
pub fn version_param(query: Option<&str>) -> Option<&str> {
    query?.split('&').find_map(|kv| {
        let v = kv.strip_prefix("v=")?;
        (v.len() == VERSION_LEN && v.bytes().all(|b| b.is_ascii_hexdigit())).then_some(v)
    })
}

/// The file under `root` a plain request path names: segments of letters, digits, `.`, `_` and `-` only, never `..`.
pub fn public_file(root: &Path, path: &str) -> Option<PathBuf> {
    let rel = path.strip_prefix('/')?;
    let mut out = root.to_path_buf();
    for seg in rel.split('/') {
        let ok = !seg.is_empty()
            && seg != "."
            && seg != ".."
            && seg
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'));
        if !ok {
            return None;
        }
        out.push(seg);
    }
    Some(out)
}

type Key = (u64, Option<SystemTime>);

fn cache() -> &'static Mutex<HashMap<PathBuf, (Key, String)>> {
    static C: OnceLock<Mutex<HashMap<PathBuf, (Key, String)>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
}

/// The version of a public file, worked out once per file (again when its size or time changes). None when the path
/// is not a plain file under `root`.
pub async fn file_version(root: &Path, path: &str) -> Option<String> {
    let file = public_file(root, path)?;
    let meta = tokio::fs::metadata(&file).await.ok()?;
    if !meta.is_file() {
        return None;
    }
    let key: Key = (meta.len(), meta.modified().ok());
    if let Some((k, v)) = cache().lock().ok()?.get(&file)
        && *k == key
    {
        return Some(v.clone());
    }
    let bytes = tokio::fs::read(&file).await.ok()?;
    let v = tokio::task::spawn_blocking(move || version_of(&bytes))
        .await
        .ok()?;
    cache().lock().ok()?.insert(file, (key, v.clone()));
    Some(v)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_are_sha256_prefixes() {
        // sha256("abc") = ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad
        assert_eq!(version_of(b"abc"), "ba7816bf8f01cfea");
    }

    #[test]
    fn version_param_wants_16_hex_digits() {
        assert_eq!(
            version_param(Some("v=ba7816bf8f01cfea")),
            Some("ba7816bf8f01cfea")
        );
        assert_eq!(
            version_param(Some("x=1&v=ba7816bf8f01cfea")),
            Some("ba7816bf8f01cfea")
        );
        assert_eq!(version_param(Some("v=ba7816bf")), None);
        assert_eq!(version_param(Some("v=zz7816bf8f01cfea")), None);
        assert_eq!(version_param(Some("w=ba7816bf8f01cfea")), None);
        assert_eq!(version_param(None), None);
    }

    #[test]
    fn public_file_refuses_anything_but_plain_paths() {
        let root = Path::new("/srv/public");
        assert_eq!(
            public_file(root, "/avatars/m02.glb"),
            Some(PathBuf::from("/srv/public/avatars/m02.glb"))
        );
        for bad in [
            "avatars/m02.glb",
            "/../etc/passwd",
            "/avatars/../../x",
            "/avatars//m02.glb",
            "/avatars/./m02.glb",
            "/avatars/m%2e.glb",
            "/",
        ] {
            assert_eq!(public_file(root, bad), None, "{bad}");
        }
    }

    #[tokio::test]
    async fn file_version_follows_the_file() {
        let dir = std::env::temp_dir().join(format!("ir-static-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("a")).unwrap();
        std::fs::write(dir.join("a/f.bin"), b"abc").unwrap();
        assert_eq!(
            file_version(&dir, "/a/f.bin").await.as_deref(),
            Some("ba7816bf8f01cfea")
        );
        // A new deploy: other bytes (and size), other version.
        std::fs::write(dir.join("a/f.bin"), b"abcd").unwrap();
        assert_eq!(
            file_version(&dir, "/a/f.bin").await,
            Some(version_of(b"abcd"))
        );
        assert_eq!(file_version(&dir, "/a/missing.bin").await, None);
        assert_eq!(file_version(&dir, "/a").await, None);
    }
}
