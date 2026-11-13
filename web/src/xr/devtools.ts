// Dev only. IWSDK's agent tooling (the managed emulator browser used for screenshots and
// scripted tests) attaches to a page only once an IWSDK World exists on it. The 2D pages
// have none, so under automation we start a tiny hidden world. Production builds drop
// this file: main.ts only imports it behind import.meta.env.DEV.

interface Tooling {
  host: HTMLElement;
  world: { destroy(): void; renderer: { dispose(): void; forceContextLoss(): void; domElement: HTMLElement } };
}
let tooling: Promise<Tooling> | null = null;

/** The round's own room is about to start on this page: one world at a time. */
export async function stopToolingWorld(): Promise<void> {
  const t = tooling;
  tooling = null;
  if (!t) return;
  const { host, world } = await t;
  const renderer = world.renderer;
  world.destroy();
  renderer.dispose();
  renderer.forceContextLoss();
  host.remove();
}

export function startToolingWorld(): Promise<void> {
  tooling ??= createToolingWorld();
  return tooling.then(() => undefined);
}

async function createToolingWorld(): Promise<Tooling> {
  const host = document.createElement('div');
  host.setAttribute('aria-hidden', 'true');
  host.style.cssText = 'position:fixed;left:0;bottom:0;width:2px;height:2px;opacity:0;pointer-events:none;';
  document.body.append(host);
  const [{ World }, project] = await Promise.all([import('@iwsdk/core'), import('virtual:iwsdk-project')]);
  const world = await World.create(host, { ...project.default, xr: false });
  return { host, world };
}
