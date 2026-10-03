import * as fs from 'fs';
import * as path from 'path';

// Đọc config từ file JSON
const configPath = path.resolve(
  process.cwd(),
  process.env.CONFIG_FILE || 'config.json',
);
const configData = fs.readFileSync(configPath, 'utf8');
const telegramConfig = JSON.parse(configData);
export { telegramConfig, configPath };
