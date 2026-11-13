// Placeholder immersive entry. It creates an empty IWSDK world for passthrough AR (world
// options come from iwsdk.config.json) so the shell proves the XR path end to end; the
// room, panel and board replace it later.
//
// The world is created before the user taps, so the tap only calls launchXR() and keeps the
// browser's user activation (requestSession needs it).

export interface ImmersiveHandle {
  enter(): void;
  exit(): void;
  destroy(): void;
}

export async function createImmersive(container: HTMLElement): Promise<ImmersiveHandle> {
  // Loaded on demand so the 2D pages never pay for the 3D runtime.
  const [{ World }, project] = await Promise.all([import('@iwsdk/core'), import('virtual:iwsdk-project')]);
  const world = await World.create(container, project.default);
  return {
    enter: () => world.launchXR(),
    exit: () => world.exitXR(),
    destroy: () => world.destroy(),
  };
}
