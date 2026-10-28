/**
 * Placement for the fallback window.
 *
 * It used to be created with no position at all, so Chrome put it wherever it
 * liked — top-left sometimes, cascaded other times. Centring it on the
 * browser window it belongs to keeps it where the user is already looking.
 */

export interface Bounds {
  left?: number;
  top?: number;
  width?: number;
  height?: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Placement {
  left?: number;
  top?: number;
}

/**
 * Centres `size` inside `bounds`.
 *
 * Coordinates are left signed on purpose: Chrome reports a window on a
 * monitor to the left of the primary one with a negative `left`, and clamping
 * that to zero would throw the popup onto the wrong screen.
 */
export function centerIn(bounds: Bounds | undefined, size: Size): Placement {
  if (
    !bounds ||
    !Number.isFinite(bounds.left) ||
    !Number.isFinite(bounds.top) ||
    !Number.isFinite(bounds.width) ||
    !Number.isFinite(bounds.height)
  ) {
    // Let Chrome decide rather than guessing at a position.
    return {};
  }

  return {
    left: Math.round(bounds.left! + (bounds.width! - size.width) / 2),
    top: Math.round(bounds.top! + (bounds.height! - size.height) / 2),
  };
}
