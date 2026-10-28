import { beforeEach } from 'vitest';
import { installChromeMock } from './helpers/chrome-mock';

// Every test starts with a clean `chrome`. Tests that need specific tabs call
// installChromeMock again with their own fixture.
beforeEach(() => {
  installChromeMock();
});
