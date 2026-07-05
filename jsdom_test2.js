const { JSDOM } = require("jsdom");
const fs = require("fs");
const html = fs.readFileSync("public/index.html", "utf8");
const clientJs = fs.readFileSync("public/client.js", "utf8");
const dom = new JSDOM(html, { url: "http://localhost:3000/", runScripts: "outside-only", pretendToBeVisual: true });
const { window } = dom;
window.io = () => ({ on: () => {}, emit: () => {}, id: "fake" });
try {
  window.eval(clientJs);
  console.log("client.js executed with NO synchronous errors");
} catch (e) {
  console.log("THREW:", e.message);
  console.log(e.stack);
}
console.log("intro-canvas present:", !!window.document.getElementById("intro-canvas"));
