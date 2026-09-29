import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { adminClient } from './sub2api.js';
import { createCheckinService } from './checkin-service.js';

export { getShanghaiDate, randomAmount } from './checkin-service.js';

const service = createCheckinService({
  storePath: path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'checkins.json'),
  request: (url, options) => adminClient.request(url, options),
});

export const checkin = service.checkin;
