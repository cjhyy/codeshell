/* global navigator, document */
// The source window paints these letters. The receiving renderer reads the captured video pixels.
const letters = {
  P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  N: ["10001", "11001", "11001", "10101", "10011", "10011", "10001"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  C: ["01111", "10000", "10000", "10000", "10000", "10000", "01111"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  U: ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
  D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
};

export function markerPage(word, title) {
  if (!["PANEL", "CLOUD"].includes(word) || !/^capture-[a-zA-Z0-9-]+$/.test(title))
    throw Error("Invalid capture marker");
  const cells = [];
  for (const [index, letter] of [...word].entries())
    letters[letter].forEach((row, y) =>
      [...row].forEach((bit, x) => {
        if (bit === "1") cells.push(`<rect x="${index * 6 + x}" y="${y}" width="1" height="1"/>`);
      }),
    );
  return `<!doctype html><title>${title}</title>
    <body style="margin:0;background:#282838;height:100vh;display:grid;place-items:center">
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 29 7" width="80%" fill="#19ebe5" shape-rendering="crispEdges">
      ${cells.join("")}
    </svg>`;
}

// This function is also installed in the fixture Panel and loopback page.
export function readMarker(rgba, width, height, alphabet = letters) {
  const lit = (x, y) => {
    const i = (y * width + x) * 4;
    return rgba[i + 1] > 145 && rgba[i + 2] > 145 && rgba[i] < 0.6 * rgba[i + 1];
  };
  let left = width,
    top = height,
    right = -1,
    bottom = -1;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      if (!lit(x, y)) continue;
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    }
  if (right - left < 58 || bottom - top < 14) return "";
  const cellWidth = (right - left + 1) / 29,
    cellHeight = (bottom - top + 1) / 7;
  let text = "";
  for (let letter = 0; letter < 5; letter++) {
    const bits = [];
    for (let row = 0; row < 7; row++) {
      let line = "";
      for (let col = 0; col < 5; col++)
        line += lit(
          Math.floor(left + (letter * 6 + col + 0.5) * cellWidth),
          Math.floor(top + (row + 0.5) * cellHeight),
        )
          ? "1"
          : "0";
      bits.push(line);
    }
    const match = Object.entries(alphabet).find(([, glyph]) =>
      glyph.every((line, row) => line === bits[row]),
    );
    if (!match) return "";
    text += match[0];
  }
  return text;
}

async function captureMarker(alphabet, decode) {
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
  const video = document.createElement("video");
  try {
    video.muted = true;
    video.srcObject = stream;
    await video.play();
    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 180;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const deadline = Date.now() + 6_000;
    while (Date.now() < deadline) {
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      const text = decode(data, canvas.width, canvas.height, alphabet);
      if (text) return { text, width: video.videoWidth, height: video.videoHeight };
      await new Promise((done) => setTimeout(done, 80));
    }
    throw Error("No fixture lettering found in captured window");
  } finally {
    for (const track of stream.getTracks()) track.stop();
    video.srcObject = null;
  }
}

export const capturePage =
  '<!doctype html><meta charset="utf-8"><title>Window capture test</title><button>Capture test window</button><script src="./read-frame.js"></script>';
export const captureScript = `document.querySelector("button").onclick = async () => {
  try {
    const result = await (${captureMarker})(${JSON.stringify(letters)}, ${readMarker});
    document.body.dataset.receipt = JSON.stringify(result);
  } catch (e) {
    document.body.dataset.receipt = JSON.stringify({error: e.name + ": " + e.message});
  }
};`;
