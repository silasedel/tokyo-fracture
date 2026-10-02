export class Input {
  keys = new Set<string>();
  pressed = new Set<string>();
  released = new Set<string>();
  mouse = { dx: 0, dy: 0, wheel: 0, left: false, right: false, leftPressed: false, rightPressed: false, leftReleased: false, rightReleased: false };
  locked = false;
  sensitivity = 1;
  invertY = false;
  onLockChange: ((locked: boolean) => void) | null = null;
  private el: HTMLElement;

  constructor(el: HTMLElement) {
    this.el = el;
    addEventListener('keydown', this.kd);
    addEventListener('keyup', this.ku);
    addEventListener('mousemove', this.mm);
    addEventListener('mousedown', this.md);
    addEventListener('mouseup', this.mu);
    addEventListener('wheel', this.wh, { passive: false });
    addEventListener('blur', this.blur);
    document.addEventListener('pointerlockchange', this.plc);
    addEventListener('contextmenu', (e) => { if (this.locked) e.preventDefault(); });
  }

  private kd = (e: KeyboardEvent) => {
    if (e.repeat) return;
    if (e.code === 'Tab' || (e.code === 'Space' && this.locked)) e.preventDefault();
    this.keys.add(e.code); this.pressed.add(e.code);
  };
  private ku = (e: KeyboardEvent) => { this.keys.delete(e.code); this.released.add(e.code); };
  private mm = (e: MouseEvent) => {
    if (!this.locked) return;
    this.mouse.dx += e.movementX * 0.0022 * this.sensitivity;
    this.mouse.dy += e.movementY * 0.0022 * this.sensitivity * (this.invertY ? -1 : 1);
  };
  private md = (e: MouseEvent) => {
    if (!this.locked) return;
    if (e.button === 0) { this.mouse.left = true; this.mouse.leftPressed = true; }
    if (e.button === 2) { this.mouse.right = true; this.mouse.rightPressed = true; }
  };
  private mu = (e: MouseEvent) => {
    if (e.button === 0) { this.mouse.left = false; this.mouse.leftReleased = true; }
    if (e.button === 2) { this.mouse.right = false; this.mouse.rightReleased = true; }
  };
  private wh = (e: WheelEvent) => {
    if (!this.locked) return;
    e.preventDefault();
    this.mouse.wheel += Math.sign(e.deltaY);
  };
  private blur = () => { this.keys.clear(); this.mouse.left = this.mouse.right = false; };
  private plc = () => {
    this.locked = document.pointerLockElement === this.el;
    if (!this.locked) this.keys.clear();
    this.onLockChange?.(this.locked);
  };

  requestLock() {
    const p = this.el.requestPointerLock() as unknown as Promise<void> | undefined;
    if (p && typeof p.catch === 'function') p.catch(() => { /* user gesture required */ });
  }
  exitLock() { if (document.pointerLockElement) document.exitPointerLock(); }

  down(code: string) { return this.keys.has(code); }
  hit(code: string) { return this.pressed.has(code); }
  up(code: string) { return this.released.has(code); }
  axis(neg: string, pos: string) { return (this.down(pos) ? 1 : 0) - (this.down(neg) ? 1 : 0); }

  endFrame() {
    this.pressed.clear(); this.released.clear();
    this.mouse.dx = 0; this.mouse.dy = 0; this.mouse.wheel = 0;
    this.mouse.leftPressed = this.mouse.rightPressed = false;
    this.mouse.leftReleased = this.mouse.rightReleased = false;
  }

  dispose() {
    removeEventListener('keydown', this.kd);
    removeEventListener('keyup', this.ku);
    removeEventListener('mousemove', this.mm);
    removeEventListener('mousedown', this.md);
    removeEventListener('mouseup', this.mu);
    removeEventListener('wheel', this.wh);
    removeEventListener('blur', this.blur);
    document.removeEventListener('pointerlockchange', this.plc);
  }
}
