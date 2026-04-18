const fs = require("fs");
const s = fs.readFileSync("node_modules/pixi.js/dist/pixi.mjs", "utf8");
const k = 'renderPipeId = "mesh"';
const j = s.indexOf(k);
console.log(s.slice(j, j + 4000));
