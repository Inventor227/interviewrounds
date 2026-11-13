// What the room asks of the headset session. Everything here is optional: a required feature the headset cannot
// grant refuses the whole session. Hands are the first-class input, but a user who has hand tracking turned off in
// the headset's settings and holds controllers must still get the room (controllers do everything hands do). The
// room places the desk by touch, so hit testing is a nicety, and without anchors the room simply stays where it was
// placed.

export const XR_FEATURES = { handTracking: true, hitTest: true, anchors: true } as const;
