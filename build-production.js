const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

console.log('🚀 Bắt đầu build production...');

// 1. Build TypeScript
console.log('📦 Đang build TypeScript...');
execSync('npm run build', { stdio: 'inherit' });

// 2. Copy files cần thiết
console.log('📁 Đang copy files...');

// Tạo thư mục cần thiết
const dirsToCreate = [
  'dist/assets',
  'dist/winloseimages',
  'dist/config',
  'dist/screenshots-result',
  'dist/screenshots-table',
  'dist/combie-image',
];

dirsToCreate.forEach((dir) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// Copy assets
if (fs.existsSync('assets')) {
  copyDir('assets', 'dist/assets');
}

// Copy winloseimages
if (fs.existsSync('winloseimages')) {
  copyDir('winloseimages', 'dist/winloseimages');
}

// Copy config
if (fs.existsSync('config')) {
  copyDir('config', 'dist/config');
}

// Copy package.json
if (fs.existsSync('package.json')) {
  fs.copyFileSync('package.json', 'dist/package.json');
}

// Copy config.json
if (fs.existsSync('config.json')) {
  fs.copyFileSync('config.json', 'dist/config.json');
}

// Copy start.bat
if (fs.existsSync('start_tool.bat')) {
  fs.copyFileSync('start_tool.bat', 'dist/start_tool.bat');
}

function copyDir(src, dest) {
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }

  const files = fs.readdirSync(src);
  files.forEach((file) => {
    const srcPath = path.join(src, file);
    const destPath = path.join(dest, file);

    if (fs.statSync(srcPath).isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  });
}

console.log('✅ Build production hoàn thành!');
console.log('🚀 Để chạy production:');
console.log('cd dist && npm install --production && node src/main.js');
console.log('Hoặc double-click: dist/start.bat');
