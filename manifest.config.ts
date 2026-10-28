import { defineManifest } from '@crxjs/vite-plugin';
import pkg from './package.json' with { type: 'json' };

export default defineManifest({
  manifest_version: 3,
  name: 'Tab Scroll — MRU Tab Switcher',
  version: pkg.version,
  description:
    'Jump between recently used tabs with a thumbnail strip, like Arc and Firefox Ctrl+Tab.',

  // "tabs" is needed to read title/url/favIconUrl; host permissions are what
  // actually allow captureVisibleTab and content-script injection anywhere.
  permissions: ['tabs', 'storage', 'scripting'],
  host_permissions: ['<all_urls>'],

  background: {
    service_worker: 'src/background/index.ts',
    type: 'module',
  },

  content_scripts: [
    {
      matches: ['<all_urls>'],
      js: ['src/content/index.ts'],
      run_at: 'document_idle',
      all_frames: false,
    },
  ],

  action: {
    default_title: 'Show recent tabs',
  },

  // Tab cannot be bound here: chrome.commands accepts only A-Z, 0-9, a short
  // list of named keys and the media keys, and every binding must include Ctrl
  // or Alt. See docs/RESEARCH.md for why that rules out the Firefox gesture.
  commands: {
    'cycle-forward': {
      suggested_key: { default: 'Alt+Q' },
      description: 'Show recent tabs / move forward through them',
    },
    'cycle-backward': {
      suggested_key: { default: 'Alt+Shift+Q' },
      description: 'Show recent tabs / move backward through them',
    },
  },

  web_accessible_resources: [
    {
      resources: ['src/fallback/index.html'],
      matches: ['<all_urls>'],
    },
  ],
});
