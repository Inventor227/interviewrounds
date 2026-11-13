// Placeholder immersive entry. It creates an empty IWSDK world for passthrough AR so the
// shell can prove the XR path end to end; the room, panel and board replace it later.
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
  const { World, SessionMode } = await import('@iwsdk/core');
  const world = await World.create(container, {
    xr: {
      sessionMode: SessionMode.ImmersiveAR,
      offer: 'none',
      features: {
        handTracking: { required: true },
        hitTest: { required: true },
        anchors: true,
        planeDetection: true,
        meshDetection: true,
      },
    },
    features: { environmentRaycast: true, spatialUI: true },
    render: { near: 0.01, far: 50 },
  });
  return {
    enter: () => world.launchXR(),
    exit: () => world.exitXR(),
    destroy: () => world.destroy(),
  };
}
