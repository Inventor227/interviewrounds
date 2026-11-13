use std::process::ExitCode;
use std::time::Duration;

use anyhow::Context;
use ir_server::{AppState, Config, db, router};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

fn main() -> ExitCode {
    let arg = std::env::args().nth(1);
    match arg.as_deref() {
        Some("--version") | Some("version") => {
            println!("ir-server {}", env!("CARGO_PKG_VERSION"));
            ExitCode::SUCCESS
        }
        // The runtime image has no shell or curl; the container health check calls this.
        Some("healthcheck") => run_async(healthcheck()),
        None | Some("serve") => run_async(serve()),
        Some(other) => {
            eprintln!("unknown command {other:?}; use serve, healthcheck or --version");
            ExitCode::from(2)
        }
    }
}

fn run_async(fut: impl Future<Output = anyhow::Result<()>>) -> ExitCode {
    let runtime = match tokio::runtime::Runtime::new() {
        Ok(rt) => rt,
        Err(err) => {
            eprintln!("error: starting the async runtime: {err}");
            return ExitCode::FAILURE;
        }
    };
    match runtime.block_on(fut) {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            eprintln!("error: {err:#}");
            ExitCode::FAILURE
        }
    }
}

async fn serve() -> anyhow::Result<()> {
    init_tracing();
    let config = Config::from_env().context("reading configuration")?;
    tracing::info!(
        origin = %config.app_origin,
        usage_phase = config.usage_phase.as_str(),
        public_dir = %config.public_dir.display(),
        "starting"
    );

    let pool = connect_with_retry(&config).await?;
    let port = config.port;
    let app = router(AppState::new(pool, config));

    let listener = TcpListener::bind(("0.0.0.0", port))
        .await
        .with_context(|| format!("binding port {port}"))?;
    tracing::info!(port, "listening");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .context("serving")?;
    tracing::info!("stopped");
    Ok(())
}

/// The database container may still be starting after a host reboot; retry for about a minute.
async fn connect_with_retry(config: &Config) -> anyhow::Result<sqlx::PgPool> {
    let mut attempt = 0;
    loop {
        attempt += 1;
        match db::connect(config).await {
            Ok(pool) => return Ok(pool),
            Err(err) if attempt < 20 => {
                tracing::warn!(attempt, error = %format!("{err:#}"), "database not ready, retrying");
                tokio::time::sleep(Duration::from_secs(3)).await;
            }
            Err(err) => return Err(err),
        }
    }
}

fn init_tracing() {
    use tracing_subscriber::EnvFilter;
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info,tower_http=info,sqlx=warn"));
    let json = std::env::var("LOG_FORMAT")
        .map(|v| v == "json")
        .unwrap_or(false);
    let builder = tracing_subscriber::fmt().with_env_filter(filter);
    if json {
        builder.json().flatten_event(true).init();
    } else {
        builder.init();
    }
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut sig) => {
                sig.recv().await;
            }
            Err(_) => std::future::pending::<()>().await,
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
    tracing::info!("shutdown signal received");
}

/// GETs `/healthz` on the local port; exit 0 only on HTTP 200.
async fn healthcheck() -> anyhow::Result<()> {
    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(8080);
    let probe = async {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).await?;
        stream
            .write_all(b"GET /healthz HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
            .await?;
        let mut buf = Vec::with_capacity(512);
        stream.read_to_end(&mut buf).await?;
        anyhow::Ok(buf)
    };
    let buf = tokio::time::timeout(Duration::from_secs(3), probe)
        .await
        .context("health check timed out")??;
    let head = String::from_utf8_lossy(&buf);
    let status = head.split_whitespace().nth(1).unwrap_or("");
    if status == "200" {
        Ok(())
    } else {
        anyhow::bail!("health check returned status {status:?}")
    }
}
