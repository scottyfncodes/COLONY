// Isometric projection (2:1 diamonds) and camera.

export const TW = 64;
export const TH = 32;
export const HALF_W = TW / 2;
export const HALF_H = TH / 2;

export interface Vec {
  x: number;
  y: number;
}

/** World tile coordinates → world-screen pixels (before camera). */
export function iso(x: number, y: number, z = 0): Vec {
  return { x: (x - y) * HALF_W, y: (x + y) * HALF_H - z };
}

/** World-screen pixels → world tile coordinates (on the ground plane). */
export function unIso(sx: number, sy: number): Vec {
  return { x: (sy / HALF_H + sx / HALF_W) / 2, y: (sy / HALF_H - sx / HALF_W) / 2 };
}

export class Camera {
  x = 0; // world-screen pixel at the centre of the view
  y = 520;
  zoom = 1;
  width = 1;
  height = 1;
  minZoom = 0.35;
  maxZoom = 2.4;

  toScreen(wx: number, wy: number): Vec {
    return { x: (wx - this.x) * this.zoom + this.width / 2, y: (wy - this.y) * this.zoom + this.height / 2 };
  }

  toWorld(sx: number, sy: number): Vec {
    return { x: (sx - this.width / 2) / this.zoom + this.x, y: (sy - this.height / 2) / this.zoom + this.y };
  }

  tileAt(sx: number, sy: number): Vec {
    const w = this.toWorld(sx, sy);
    return unIso(w.x, w.y);
  }

  pan(dx: number, dy: number): void {
    this.x -= dx / this.zoom;
    this.y -= dy / this.zoom;
    this.clamp();
  }

  zoomAt(factor: number, sx: number, sy: number): void {
    const before = this.toWorld(sx, sy);
    this.zoom = Math.max(this.minZoom, Math.min(this.maxZoom, this.zoom * factor));
    const after = this.toWorld(sx, sy);
    this.x += before.x - after.x;
    this.y += before.y - after.y;
    this.clamp();
  }

  centerOn(tx: number, ty: number): void {
    const p = iso(tx, ty);
    this.x = p.x;
    this.y = p.y;
    this.clamp();
  }

  clamp(): void {
    this.x = Math.max(-1350, Math.min(1350, this.x));
    this.y = Math.max(-180, Math.min(1250, this.y));
  }
}
