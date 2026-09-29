import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createUserClient } from './sub2api.js';
import { createBindingStore } from './binding-store.js';

export { maskEmail } from './binding-store.js';

const store = createBindingStore({
  storePath: path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'bindings.json'),
  createUserClient,
});

export const { getBinding, bind, unbind, getClient, removeClient } = store;
