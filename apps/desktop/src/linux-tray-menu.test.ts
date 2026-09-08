import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  BaseWindow,
  BrowserWindowConstructorOptions,
  Display,
  Menu,
  PopupOptions,
} from 'electron';
import { createLinuxTrayMenuPopup, resolveLinuxTrayMenuAnchor } from './linux-tray-menu';

const topPanelDisplay = {
  bounds: { x: -1920, y: 0, width: 1920, height: 1080 },
  workArea: { x: -1920, y: 30, width: 1920, height: 1050 },
} as Display;

describe('Linux tray menu popup', () => {
  it('anchors below a top panel on the pointer monitor without fixed screen coordinates', () => {
    assert.deepEqual(resolveLinuxTrayMenuAnchor(
      { x: -84, y: 12 },
      { x: 0, y: 0, width: 0, height: 0 },
      topPanelDisplay,
    ), { x: -84, y: 30 });

    assert.deepEqual(resolveLinuxTrayMenuAnchor(
      { x: -84, y: 12 },
      { x: -96, y: 3, width: 22, height: 22 },
      topPanelDisplay,
    ), { x: -96, y: 30 });

    assert.deepEqual(resolveLinuxTrayMenuAnchor(
      { x: -84, y: 12 },
      { x: 0, y: 0, width: 22, height: 22 },
      topPanelDisplay,
    ), { x: -84, y: 30 }, 'stale bounds from another monitor are ignored');
  });

  it('uses icon geometry for floating panels and lets the native runner flip bottom/side anchors', () => {
    const display = {
      bounds: { x: 0, y: 0, width: 1600, height: 900 },
      workArea: { x: 36, y: 0, width: 1564, height: 864 },
    } as Display;
    assert.deepEqual(resolveLinuxTrayMenuAnchor(
      { x: 12, y: 400 },
      { x: 4, y: 390, width: 24, height: 24 },
      display,
    ), { x: 36, y: 390 });
    assert.deepEqual(resolveLinuxTrayMenuAnchor(
      { x: 800, y: 882 },
      { x: 0, y: 0, width: 0, height: 0 },
      display,
    ), { x: 800, y: 864 });
    assert.deepEqual(resolveLinuxTrayMenuAnchor(
      { x: 510, y: 210 },
      { x: 500, y: 200, width: 22, height: 22 },
      { bounds: display.bounds, workArea: display.bounds },
    ), { x: 500, y: 222 });
  });

  it('maps a dedicated owner until native outside dismissal and destroys it without leaking a window', () => {
    let cursor = { x: -84, y: 12 };
    const hostOptions: BrowserWindowConstructorOptions[] = [];
    const positions: Array<[number, number]> = [];
    let shows = 0;
    let destroys = 0;
    const pendingDestructions: Array<() => void> = [];
    const flushHostDestructions = () => {
      for (const destroy of pendingDestructions.splice(0)) destroy();
    };
    const hosts: BaseWindow[] = [];
    const createHost = (options: BrowserWindowConstructorOptions): BaseWindow => {
      hostOptions.push(options);
      let destroyed = false;
      const host = {
        isDestroyed: () => destroyed,
        setPosition: (x: number, y: number) => { positions.push([x, y]); },
        showInactive: () => { shows += 1; },
        destroy: () => { destroyed = true; destroys += 1; },
      } as unknown as BaseWindow;
      hosts.push(host);
      return host;
    };
    let popupOptions: PopupOptions | undefined;
    let popupCalls = 0;
    let closeCalls = 0;
    const menu = {
      popup: (options: PopupOptions) => { popupCalls += 1; popupOptions = options; },
      closePopup: (window?: BaseWindow) => {
        closeCalls += 1;
        assert.equal(window, hosts.at(-1));
      },
    } as unknown as Menu;
    const popup = createLinuxTrayMenuPopup({
      screen: {
        getCursorScreenPoint: () => cursor,
        getDisplayNearestPoint: () => topPanelDisplay,
      } as unknown as typeof import('electron').screen,
      createHost,
      environment: {},
      scheduleHostDestroy: callback => { pendingDestructions.push(callback); },
    });
    const emptyGeometry = {
      bounds: { x: 0, y: 0, width: 0, height: 0 },
      position: { x: 0, y: 0 },
    };

    popup.popup(menu, emptyGeometry);
    assert.equal(hostOptions[0]?.x, -84);
    assert.equal(hostOptions[0]?.y, 30);
    assert.equal(hostOptions[0]?.show, false);
    assert.equal(hostOptions[0]?.transparent, true);
    assert.equal(shows, 1);
    assert.deepEqual(positions, [[-84, 30]]);
    assert.equal(popupCalls, 1);
    assert.equal(popupOptions?.window, hosts[0]);
    assert.equal(popupOptions?.x, 0);
    assert.equal(popupOptions?.y, 0);
    assert.equal(popupOptions?.sourceType, 'mouse');

    popupOptions?.callback?.();
    assert.equal(destroys, 0, 'the native callback must not destroy its owner while the menu runner unwinds');
    flushHostDestructions();
    assert.equal(destroys, 1, 'the transient owner is destroyed on the next event-loop turn');

    cursor = { x: -250, y: 8 };
    popup.popup(menu, emptyGeometry);
    assert.equal(hosts.length, 2, 'a closed owner cannot keep Electron alive or affect app activation');
    assert.deepEqual(positions.at(-1), [-250, 30]);
    assert.equal(shows, 2);
    assert.equal(popupCalls, 2);

    popup.popup(menu, emptyGeometry);
    assert.equal(closeCalls, 1, 'activation while open toggles the native popup closed');
    popupOptions?.callback?.();
    flushHostDestructions();
    assert.equal(destroys, 2);

    popup.popup(menu, emptyGeometry);
    popup.close();
    assert.equal(closeCalls, 2, 'shutdown closes the active native menu first');
    assert.equal(destroys, 2, 'shutdown also defers owner destruction past closePopup');
    flushHostDestructions();
    assert.equal(destroys, 3);
    popupOptions?.callback?.();
    assert.equal(destroys, 3, 'a late close callback cannot touch the destroyed host');
  });

  it('uses the native cursor position instead of positioning the transient owner on Wayland', () => {
    let hostOptions: BrowserWindowConstructorOptions | undefined;
    let popupOptions: PopupOptions | undefined;
    let positions = 0;
    let shows = 0;
    let destroys = 0;
    let scheduledDestroy: (() => void) | undefined;
    const host = {
      isDestroyed: () => false,
      setPosition: () => { positions += 1; },
      showInactive: () => { shows += 1; },
      destroy: () => { destroys += 1; },
    } as unknown as BaseWindow;
    const popup = createLinuxTrayMenuPopup({
      screen: {
        getCursorScreenPoint: () => assert.fail('Wayland must not compute a global owner position'),
        getDisplayNearestPoint: () => assert.fail('Wayland must not compute a global owner position'),
      },
      createHost: (options) => {
        hostOptions = options;
        return host;
      },
      environment: { XDG_SESSION_TYPE: 'wayland' },
      scheduleHostDestroy: callback => { scheduledDestroy = callback; },
    });
    const menu = {
      popup: (options: PopupOptions) => { popupOptions = options; },
      closePopup: () => {},
    } as unknown as Menu;

    popup.popup(menu, {
      bounds: { x: 10, y: 10, width: 20, height: 20 },
      position: { x: 15, y: 15 },
    });

    assert.equal(hostOptions?.x, undefined);
    assert.equal(hostOptions?.y, undefined);
    assert.equal(positions, 0);
    assert.equal(shows, 1);
    assert.equal(popupOptions?.window, host);
    assert.equal(popupOptions?.x, undefined);
    assert.equal(popupOptions?.y, undefined);
    assert.equal(popupOptions?.sourceType, 'mouse');

    popupOptions?.callback?.();
    assert.equal(destroys, 0, 'Wayland also keeps the native owner alive through callback unwind');
    scheduledDestroy?.();
    assert.equal(destroys, 1, 'native menu dismissal still destroys its transient owner');
  });
});
