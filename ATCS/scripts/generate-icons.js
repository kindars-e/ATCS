
// Save this as scripts/generate-icons.js
// Run: node scripts/generate-icons.js

const sharp = require('sharp');
const fs = require('fs').promises;
const path = require('path');

const sizes = [72, 96, 128, 144, 152, 192, 384, 512];

async function generateIcons() {
  // Create a simple icon with SVG
  const svgIcon = `
    <svg width="512" height="512" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
      <rect width="512" height="512" fill="#0284c7"/>
      <circle cx="256" cy="200" r="80" fill="white"/>
      <path d="M 256 300 L 180 380 L 332 380 Z" fill="white"/>
      <circle cx="256" cy="200" r="40" fill="#0284c7"/>
      <rect x="240" y="250" width="32" height="80" fill="white"/>
    </svg>
  `;

  // Ensure public directory exists
  await fs.mkdir(path.join(process.cwd(), 'public'), { recursive: true });

  // Generate icons for each size
  for (const size of sizes) {
    await sharp(Buffer.from(svgIcon))
      .resize(size, size)
      .png()
      .toFile(path.join(process.cwd(), 'public', `icon-${size}x${size}.png`));
    
    console.log(`Generated icon-${size}x${size}.png`);
  }

  // Generate special icons
  await sharp(Buffer.from(svgIcon))
    .resize(96, 96)
    .png()
    .toFile(path.join(process.cwd(), 'public', 'new-chat-96x96.png'));

  await sharp(Buffer.from(svgIcon.replace('#0284c7', '#059669')))
    .resize(96, 96)
    .png()
    .toFile(path.join(process.cwd(), 'public', 'broadcast-96x96.png'));

  console.log('All icons generated successfully!');
}

generateIcons().catch(console.error);
