// Dev only. IWSDK's agent tooling (the managed emulator browser used for screenshots and
// scripted tests) attaches to a page only once an IWSDK World exists on it. The 2D pages
// have none, so under automation we start a tiny hidden world. Production builds drop
// this file: main.ts only imports it behind import.meta.env.DEV.

export async function startToolingWorld(): Promise<void> {
  const host = document.createElement('div');
  host.setAttribute('aria-hidden', 'true');
  host.style.cssText = 'position:fixed;left:0;bottom:0;width:2px;height:2px;opacity:0;pointer-events:none;';
  document.body.append(host);
  const [{ World }, project] = await Promise.all([import('@iwsdk/core'), import('virtual:iwsdk-project')]);
  await World.create(host, { ...project.default, xr: false });
}
