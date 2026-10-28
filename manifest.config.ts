import { defineManifest } from '@crxjs/vite-plugin';
import pkg from './package.json' with { type: 'json' };

export default defineManifest({
  manifest_version: 3,
  name: 'Tab Scroll — MRU Tab Switcher',
  version: pkg.version,
  description:
    'Hold Alt and tap Q for a strip of recent tabs. Tab to move, release to switch.',

  // "tabs" is needed to read title and favicon; host permissions are what
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
      // document_start keeps the warm overlay ready long before a heavy app
      // like Gmail goes idle, which is when the hotkey is likely to be used.
      run_at: 'document_start',
      all_frames: false,
    },
  ],

  action: {
    default_title: 'Show recent tabs',
  },

  // One binding, deliberately. Tab cannot be bound here at all — chrome.commands
  // accepts only A-Z, 0-9, a short list of named keys and the media keys, and
  // every binding must include Ctrl or Alt. See docs/RESEARCH.md.
  //
  // Alt is Option on macOS, and Option+Tab is free there, which is what lets
  // Tab move the selection. MacCtrl was considered and rejected: Control+Tab
  // is Chrome's own next-tab shortcut on macOS and would never reach the page.
  commands: {
    'open-switcher': {
      suggested_key: { default: 'Alt+Q' },
      description: 'Show recent tabs (hold the modifier, Tab to move, release to switch)',
    },
  },

  web_accessible_resources: [
    {
      resources: ['src/fallback/index.html'],
      matches: ['<all_urls>'],
    },
  ],
});
