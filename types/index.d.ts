// The decorated mod's session state.

// When the last animation frame was asked for, in ms since the epoch.
export type Tick = number

declare module 'claude-code' {
  interface PluginState {
    // The replies playing an animated <svg> read it, so each write draws a frame.
    decorated: { tick: Tick }
  }
}
