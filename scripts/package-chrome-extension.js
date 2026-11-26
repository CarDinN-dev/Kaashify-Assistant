'use strict';

const path = require('node:path');
const fs = require('node:fs');
const Zip = require('adm-zip');

const root = path.join(__dirname, '..');
const extension = path.join(root, 'chrome-extension');
const files = ['manifest.json', 'background.js', 'page.js', 'icon128.png'];
const output = path.resolve(process.argv[2] || path.join(root, 'build', 'Kaashify-Chrome.zip'));
const archive = new Zip();
for (const name of files) archive.addFile(name, fs.readFileSync(path.join(extension, name)));
for (const name of ['LICENSE', 'NOTICE']) archive.addFile(name, fs.readFileSync(path.join(root, name)));
fs.mkdirSync(path.dirname(output), { recursive: true });
archive.writeZip(output);
console.log(output);
