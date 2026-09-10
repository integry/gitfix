import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assertPackagedLayout, parseEventRecord } from './packaged-layout.mjs';

const bounds = (left, top, width, height) => ({
  bottom: top + height,
  height,
  left,
  right: left + width,
  top,
  width,
});

const layout = ({
  windowWidth = 1280,
  windowHeight = 820,
  viewportWidth = 1280,
  viewportHeight = 820,
  workAreaWidth = 1280,
  workAreaHeight = 900,
} = {}) => ({
  windowBounds: { x: 0, y: 0, width: windowWidth, height: windowHeight },
  contentBounds: { x: 0, y: 0, width: viewportWidth, height: viewportHeight },
  workArea: { x: 0, y: 0, width: workAreaWidth, height: workAreaHeight },
  viewport: { width: viewportWidth, height: viewportHeight },
  chrome: {
    dragRegion: bounds(0, 0, viewportWidth - 138, 56),
    dragRegionStyle: 'drag',
    legacyTitleRowCount: 0,
    nativeControlLabels: ['Minimize window', 'Maximize or restore window', 'Close window'],
    nativeControlRegion: bounds(viewportWidth - 138, 0, 138, 56),
    nativeControlRegionStyle: 'no-drag',
    overlayRect: bounds(0, 0, 0, 0),
    overlayVisible: false,
  },
  nativeChrome: {
    closable: true,
    maximizable: true,
    minimizable: true,
    resizable: true,
  },
  entry: bounds(0, 0, viewportWidth, viewportHeight),
  card: bounds((viewportWidth - 580) / 2, 40, 580, 640),
  logo: bounds((viewportWidth - 32) / 2, 72, 32, 32),
  heading: bounds((viewportWidth - 420) / 2, 132, 420, 58),
  connectButton: bounds((viewportWidth - 520) / 2, 230, 520, 76),
  connectDescription: bounds((viewportWidth - 300) / 2, 270, 300, 18),
});

describe('packaged desktop event parsing', () => {
  it('returns the first full record for the exact matching event', () => {
    const firstProof = {
      event: 'desktop.renderer.mvp_flows.ready',
      localProfile: true,
      remoteActiveProfile: true,
      lifecycleBoundary: true,
      connectUiPopulated: true,
    };
    const output = [
      'not JSON: desktop.renderer.mvp_flows.ready',
      JSON.stringify({ event: 'desktop.renderer.mvp_flows.ready.extra', localProfile: false }),
      JSON.stringify({ event: 'desktop.renderer.other', note: 'desktop.renderer.mvp_flows.ready' }),
      JSON.stringify(firstProof),
      JSON.stringify({ event: 'desktop.renderer.mvp_flows.ready', localProfile: false }),
    ].join('\n');

    assert.deepEqual(parseEventRecord(output, firstProof.event), firstProof);
  });

  it('returns undefined when the event is absent', () => {
    const output = [
      '{malformed',
      JSON.stringify({ event: 'desktop.renderer.other' }),
    ].join('\n');

    assert.equal(parseEventRecord(output, 'desktop.renderer.mvp_flows.ready'), undefined);
  });
});

describe('packaged desktop layout assertions', () => {
  it('retains the exact 1280x820 Linux Xvfb proof', () => {
    assert.doesNotThrow(() => assertPackagedLayout(layout(), 'linux'));
    assert.throws(
      () => assertPackagedLayout(layout({ windowWidth: 1279 }), 'linux'),
      /Linux window was not 1280x820/,
    );
  });

  it('rejects Linux client decoration and duplicated or unsafe title-bar rows', () => {
    assert.throws(
      () => assertPackagedLayout(layout({ viewportWidth: 1272, viewportHeight: 816 }), 'linux'),
      /client decoration changed the requested window boundary/,
    );
    const duplicated = layout();
    duplicated.chrome.legacyTitleRowCount = 1;
    assert.throws(
      () => assertPackagedLayout(duplicated, 'linux'),
      /not one safe native-control band/,
    );
    const overlapping = layout();
    overlapping.chrome.dragRegion.width += 1;
    overlapping.chrome.dragRegion.right += 1;
    assert.throws(
      () => assertPackagedLayout(overlapping, 'linux'),
      /not one safe native-control band/,
    );
    const unresizable = layout();
    unresizable.nativeChrome.resizable = false;
    assert.throws(
      () => assertPackagedLayout(unresizable, 'linux'),
      /native window capabilities were reduced/,
    );
  });

  it('accepts a safe 1024x720 Windows display clamp with intact contained content', () => {
    assert.doesNotThrow(() => assertPackagedLayout(layout({
      windowWidth: 1024,
      windowHeight: 720,
      viewportWidth: 1024,
      viewportHeight: 681,
      workAreaWidth: 1024,
      workAreaHeight: 720,
    }), 'win32'));
  });

  it('rejects unsafe Windows clamps and content outside the visible work area', () => {
    assert.throws(
      () => assertPackagedLayout(layout({ windowWidth: 879 }), 'win32'),
      /outside the safe clamped range/,
    );
    assert.throws(
      () => assertPackagedLayout(layout({ workAreaWidth: 1024 }), 'win32'),
      /outside the visible work area/,
    );
  });
});
