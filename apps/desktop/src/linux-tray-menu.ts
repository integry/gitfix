import type {
  BaseWindow,
  BrowserWindowConstructorOptions,
  Display,
  Menu,
  Point,
  Rectangle,
} from 'electron';

export interface LinuxTrayActivationGeometry {
  bounds: Rectangle;
  position: Point;
}

type LinuxTrayMenuScreen = Pick<typeof import('electron').screen,
  'getCursorScreenPoint' | 'getDisplayNearestPoint'>;

interface LinuxSessionEnvironment {
  WAYLAND_DISPLAY?: string;
  XDG_SESSION_TYPE?: string;
}

interface LinuxTrayMenuPopupOptions {
  screen: LinuxTrayMenuScreen;
  createHost(options: BrowserWindowConstructorOptions): BaseWindow;
  environment?: LinuxSessionEnvironment;
  scheduleMenuOpen?(callback: () => void): void;
  scheduleHostDestroy?(callback: () => void): void;
}

export interface LinuxTrayMenuPopup {
  popup(menu: Menu, activation: LinuxTrayActivationGeometry): void;
  close(): void;
}

const isPoint = (value: Point): boolean => Number.isFinite(value.x) && Number.isFinite(value.y);

const isRectangle = (value: Rectangle): boolean => (
  Number.isFinite(value.x)
  && Number.isFinite(value.y)
  && Number.isFinite(value.width)
  && Number.isFinite(value.height)
  && value.width > 0
  && value.height > 0
);

const clamp = (value: number, minimum: number, maximum: number): number => (
  Math.min(Math.max(value, minimum), maximum)
);

const overlaps = (start: number, length: number, otherStart: number, otherLength: number): boolean => (
  start < otherStart + otherLength && start + length > otherStart
);

const containsPoint = (rectangle: Rectangle, point: Point): boolean => (
  point.x >= rectangle.x
  && point.x < rectangle.x + rectangle.width
  && point.y >= rectangle.y
  && point.y < rectangle.y + rectangle.height
);

const isWaylandSession = (environment: LinuxSessionEnvironment): boolean => (
  environment.XDG_SESSION_TYPE?.toLowerCase() === 'wayland'
  || Boolean(environment.WAYLAND_DISPLAY)
);

/**
 * Resolve a screen-coordinate anchor at the panel's work-area edge. Electron's
 * Linux tray backends currently report empty icon bounds, so the physical
 * pointer and the selected monitor's work area are the authoritative fallback.
 */
export const resolveLinuxTrayMenuAnchor = (
  pointer: Point,
  trayBounds: Rectangle,
  display: Pick<Display, 'bounds' | 'workArea'>,
): Point => {
  const { workArea } = display;
  const workRight = workArea.x + workArea.width;
  const workBottom = workArea.y + workArea.height;
  // Only trust event bounds that actually contain this activation. This also
  // rejects empty or stale primary-monitor geometry on a secondary monitor.
  const usableTrayBounds = isRectangle(trayBounds) && containsPoint(trayBounds, pointer)
    ? trayBounds
    : null;

  if (usableTrayBounds) {
    const trayRight = usableTrayBounds.x + usableTrayBounds.width;
    const trayBottom = usableTrayBounds.y + usableTrayBounds.height;
    if (trayBottom <= workArea.y
      && overlaps(usableTrayBounds.x, usableTrayBounds.width, workArea.x, workArea.width)) {
      return { x: clamp(usableTrayBounds.x, workArea.x, workRight - 1), y: workArea.y };
    }
    if (usableTrayBounds.y >= workBottom
      && overlaps(usableTrayBounds.x, usableTrayBounds.width, workArea.x, workArea.width)) {
      return { x: clamp(usableTrayBounds.x, workArea.x, workRight - 1), y: workBottom };
    }
    if (trayRight <= workArea.x
      && overlaps(usableTrayBounds.y, usableTrayBounds.height, workArea.y, workArea.height)) {
      return { x: workArea.x, y: clamp(usableTrayBounds.y, workArea.y, workBottom - 1) };
    }
    if (usableTrayBounds.x >= workRight
      && overlaps(usableTrayBounds.y, usableTrayBounds.height, workArea.y, workArea.height)) {
      return { x: workRight, y: clamp(usableTrayBounds.y, workArea.y, workBottom - 1) };
    }

    // A floating panel does not alter the work area. Its actual icon geometry
    // is still better evidence than an assumed panel size or screen edge.
    return { x: usableTrayBounds.x, y: trayBottom };
  }

  if (pointer.y < workArea.y) {
    return { x: clamp(pointer.x, workArea.x, workRight - 1), y: workArea.y };
  }
  if (pointer.y >= workBottom) {
    return { x: clamp(pointer.x, workArea.x, workRight - 1), y: workBottom };
  }
  if (pointer.x < workArea.x) {
    return { x: workArea.x, y: clamp(pointer.y, workArea.y, workBottom - 1) };
  }
  if (pointer.x >= workRight) {
    return { x: workRight, y: clamp(pointer.y, workArea.y, workBottom - 1) };
  }

  return pointer;
};

export const createLinuxTrayMenuPopup = (options: LinuxTrayMenuPopupOptions): LinuxTrayMenuPopup => {
  let host: BaseWindow | null = null;
  let openingMenu: Menu | null = null;
  let openMenu: Menu | null = null;
  let closed = false;
  const canPositionHost = !isWaylandSession(options.environment ?? process.env);
  const pendingHostDestruction = new Set<BaseWindow>();
  const scheduleMenuOpen = options.scheduleMenuOpen ?? setImmediate;
  const scheduleHostDestroy = options.scheduleHostDestroy ?? setImmediate;

  const destroyHostAfterNativeMenuClose = (popupHost: BaseWindow): void => {
    if (pendingHostDestruction.has(popupHost)) return;
    pendingHostDestruction.add(popupHost);
    // Electron invokes Menu.popup's callback while the native Views menu
    // runner is still unwinding owner references. Destroying its BaseWindow in
    // that callback can invalidate those references and crash the process.
    scheduleHostDestroy(() => {
      pendingHostDestruction.delete(popupHost);
      if (!popupHost.isDestroyed()) popupHost.destroy();
    });
  };

  const releaseHost = (menu: Menu, popupHost: BaseWindow): void => {
    if (openMenu !== menu || host !== popupHost) return;
    openMenu = null;
    host = null;
    destroyHostAfterNativeMenuClose(popupHost);
  };

  return {
    popup(menu, activation) {
      if (closed) return;
      if (openingMenu) {
        const openingHost = host;
        openingMenu = null;
        host = null;
        if (openingHost) destroyHostAfterNativeMenuClose(openingHost);
        return;
      }
      if (openMenu) {
        openMenu.closePopup(host && !host.isDestroyed() ? host : undefined);
        return;
      }

      let anchor: Point | null = null;
      if (canPositionHost) {
        const cursor = options.screen.getCursorScreenPoint();
        const pointer = isPoint(cursor) ? cursor : activation.position;
        const display = options.screen.getDisplayNearestPoint(pointer);
        anchor = resolveLinuxTrayMenuAnchor(pointer, activation.bounds, display);
      }

      const popupHost = options.createHost({
        ...(anchor ? { x: anchor.x, y: anchor.y } : {}),
        width: 1,
        height: 1,
        useContentSize: true,
        show: false,
        // Linux does not implement skipTaskbar. A toolbar keeps this mapped,
        // focusable menu owner out of task lists instead of flashing the app.
        type: 'toolbar',
        focusable: true,
        frame: false,
        transparent: true,
        backgroundColor: '#00000000',
        hasShadow: false,
        resizable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      });
      host = popupHost;
      openingMenu = menu;

      // Menu.popup() is implemented by Electron's native Views menu runner on
      // Linux. Giving it a mapped, menu-scoped owner lets it take and release
      // the native input grab independently of a hidden/minimized main window.
      popupHost.showInactive();
      // Reapply after mapping so X11 window-manager placement cannot move the
      // otherwise invisible owner away from its monitor-relative anchor.
      if (anchor) popupHost.setPosition(anchor.x, anchor.y, false);
      // The Linux Tray activation is delivered from native press/release
      // handling, and BrowserWindow mapping also completes asynchronously.
      // Opening in that same callback makes the release dismiss the new menu
      // on XFCE. Wait one event-loop turn so both native callbacks unwind.
      scheduleMenuOpen(() => {
        if (closed || openingMenu !== menu || host !== popupHost || popupHost.isDestroyed()) return;
        if (anchor) popupHost.setPosition(anchor.x, anchor.y, false);
        openingMenu = null;
        openMenu = menu;
        try {
          menu.popup({
            window: popupHost,
            // Wayland does not permit global top-level positioning. Omitting
            // coordinates lets the native menu runner use the current cursor
            // while retaining the transient owner for outside-click dismissal.
            ...(anchor ? { x: 0, y: 0 } : {}),
            sourceType: 'mouse',
            callback: () => releaseHost(menu, popupHost),
          });
        } catch (error) {
          releaseHost(menu, popupHost);
          throw error;
        }
      });
    },
    close() {
      if (closed) return;
      closed = true;
      const closingMenu = openMenu;
      const closingHost = host;
      if (closingMenu) {
        closingMenu.closePopup(closingHost && !closingHost.isDestroyed() ? closingHost : undefined);
      }
      openingMenu = null;
      openMenu = null;
      host = null;
      if (closingHost) destroyHostAfterNativeMenuClose(closingHost);
    },
  };
};
