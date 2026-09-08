/** Pure-TS PNG (RGBA8, non-interlaced) encode/decode on node:zlib, plus visual diffing. */
import { deflateSync, inflateSync } from "node:zlib";

export interface PngImage {
	width: number;
	height: number;
	/** RGBA, row-major, 4 bytes per pixel. */
	pixels: Uint8Array;
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type: string, data: Buffer): Buffer {
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length);
	const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
	const crc = crc32(body);
	const tail = Buffer.alloc(4);
	tail.writeUInt32BE(crc >>> 0);
	return Buffer.concat([length, body, tail]);
}

// CRC-32 (PNG polynomial), table-driven.
const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let value = 0; value < 256; value++) {
		let checksum = value;
		for (let bit = 0; bit < 8; bit++) checksum = checksum & 1 ? 0xedb88320 ^ (checksum >>> 1) : checksum >>> 1;
		table[value] = checksum >>> 0;
	}
	return table;
})();
function crc32(data: Buffer): number {
	let checksum = 0xffffffff;
	for (let index = 0; index < data.length; index++) checksum = CRC_TABLE[(checksum ^ data[index]) & 0xff] ^ (checksum >>> 8);
	return (checksum ^ 0xffffffff) >>> 0;
}

export function encodePng(image: PngImage): Buffer {
	if (!Number.isInteger(image.width) || !Number.isInteger(image.height) || image.width < 1 || image.height < 1 || image.width > 32768 || image.height > 32768) throw new Error("PNG dimensions must be integers from 1 to 32768.");
	if (image.pixels.length !== image.width * image.height * 4) throw new Error("PNG pixel buffer must be width*height*4 bytes (RGBA).");
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(image.width, 0);
	ihdr.writeUInt32BE(image.height, 4);
	ihdr[8] = 8;  // bit depth
	ihdr[9] = 6;  // color type: truecolor + alpha
	ihdr[10] = 0; // compression
	ihdr[11] = 0; // filter
	ihdr[12] = 0; // no interlace
	const stride = image.width * 4;
	const raw = Buffer.alloc((stride + 1) * image.height);
	for (let row = 0; row < image.height; row++) {
		raw[row * (stride + 1)] = 0; // filter: none
		for (let index = 0; index < stride; index++) raw[row * (stride + 1) + 1 + index] = image.pixels[row * stride + index];
	}
	return Buffer.concat([SIGNATURE, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

export function decodePng(data: Uint8Array | Buffer): PngImage {
	const bytes = data instanceof Uint8Array && !(data instanceof Buffer) ? Buffer.from(data) : data;
	if (bytes.length < 8 || !bytes.subarray(0, 8).equals(SIGNATURE)) throw new Error("Not a PNG file (bad signature).");
	let offset = 8;
	let width = 0, height = 0, bitDepth = 0, colorType = -1, interlace = 0;
	const idat: Buffer[] = [];
	while (offset + 8 <= bytes.length) {
		const length = bytes.readUInt32BE(offset);
		const type = bytes.toString("ascii", offset + 4, offset + 8);
		const body = bytes.subarray(offset + 8, offset + 8 + length);
		if (offset + 12 + length > bytes.length) throw new Error("Truncated PNG chunk.");
		if (type === "IHDR") {
			if (body.length !== 13) throw new Error("Bad IHDR chunk.");
			width = body.readUInt32BE(0); height = body.readUInt32BE(4);
			bitDepth = body[8]; colorType = body[9]; interlace = body[12];
			if (bitDepth !== 8 || colorType !== 6 || interlace !== 0) throw new Error("This rebuild decodes 8-bit RGBA, non-interlaced PNGs only.");
			if (width < 1 || height < 1 || width > 32768 || height > 32768) throw new Error("PNG dimensions out of range.");
		} else if (type === "IDAT") idat.push(Buffer.from(body));
		else if (type === "IEND") break;
		offset += 12 + length;
	}
	if (!width || !height) throw new Error("PNG is missing its IHDR chunk.");
	const raw = inflateSync(Buffer.concat(idat), { maxOutputLength: width * height * 5 + (width + 1) * height });
	const stride = width * 4;
	if (raw.length !== (stride + 1) * height) throw new Error(`PNG scanlines are the wrong size (expected ${(stride + 1) * height} bytes).`);
	const pixels = new Uint8Array(width * height * 4);
	let previous = new Uint8Array(stride);
	for (let row = 0; row < height; row++) {
		const filter = raw[row * (stride + 1)];
		const line = new Uint8Array(raw.subarray(row * (stride + 1) + 1, (row + 1) * (stride + 1)));
		for (let index = 0; index < stride; index++) {
			const a = index >= 4 ? line[index - 4] : 0;
			const b = previous[index];
			const c = index >= 4 ? previous[index - 4] : 0;
			let value = line[index];
			switch (filter) {
				case 0: break;
				case 1: value = (value + a) & 0xff; break;
				case 2: value = (value + b) & 0xff; break;
				case 3: value = (value + ((a + b) >> 1)) & 0xff; break;
				case 4: {
					const p = a + b - c;
					const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
					value = (value + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
					break;
				}
				default: throw new Error(`Unsupported PNG filter ${filter}.`);
			}
			line[index] = value;
		}
		pixels.set(line, row * stride);
		previous = line;
	}
	return { width, height, pixels };
}

export interface DiffResult {
	identical: boolean;
	/** Fraction of pixels that differ beyond the per-channel threshold. */
	diffRatio: number;
	width: number;
	height: number;
	/** Tightest bounding box around differing pixels, when any differ. */
	bbox: [number, number, number, number] | null;
	/** Sampled differing coordinates (up to 8), for report context. */
	samples: [number, number][];
}

/** Pixel diff with a per-channel threshold (0-255). Size mismatch is a hard error. */
export function diffImages(baseline: PngImage, actual: PngImage, threshold = 12): DiffResult {
	if (baseline.width !== actual.width || baseline.height !== actual.height) throw new Error(`Images differ in size: ${baseline.width}x${baseline.height} vs ${actual.width}x${actual.height}. Capture at the same resolution before diffing.`);
	if (!Number.isFinite(threshold) || threshold < 0 || threshold > 255) throw new Error("Threshold must be 0-255 per channel.");
	let differing = 0, minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
	const samples: [number, number][] = [];
	for (let y = 0; y < baseline.height; y++) {
		for (let x = 0; x < baseline.width; x++) {
			const index = (y * baseline.width + x) * 4;
			let changed = false;
			for (let channel = 0; channel < 4; channel++) {
				if (Math.abs(baseline.pixels[index + channel] - actual.pixels[index + channel]) > threshold) { changed = true; break; }
			}
			if (!changed) continue;
			differing += 1;
			minX = Math.min(minX, x); minY = Math.min(minY, y);
			maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
			if (samples.length < 8) samples.push([x, y]);
		}
	}
	const total = baseline.width * baseline.height;
	return {
		identical: differing === 0,
		diffRatio: total ? differing / total : 0,
		width: baseline.width, height: baseline.height,
		bbox: differing ? [minX, minY, maxX, maxY] : null,
		samples,
	};
}

export interface TextImageOptions {
	/** Pixel size per text column (default 8). */
	cellWidth?: number;
	/** Pixel size per text row (default 16). */
	cellHeight?: number;
	/** Foreground RGB, e.g. [37, 42, 37]. */
	foreground?: [number, number, number];
	/** Background RGB. */
	background?: [number, number, number];
}

/** Render terminal text into an RGBA buffer — the TerminalProvider's screenshot surface. */
export function textToImage(lines: string[], options: TextImageOptions = {}): PngImage {
	const cellWidth = options.cellWidth ?? 8, cellHeight = options.cellHeight ?? 16;
	const foreground = options.foreground ?? [235, 237, 220];
	const background = options.background ?? [37, 42, 37];
	const width = Math.max(1, ...lines.map(line => line.length)) * cellWidth;
	const height = Math.max(1, lines.length) * cellHeight;
	const pixels = new Uint8Array(width * height * 4);
	const put = (x: number, y: number, rgb: [number, number, number]) => {
		if (x < 0 || y < 0 || x >= width || y >= height) return;
		const index = (y * width + x) * 4;
		pixels[index] = rgb[0]; pixels[index + 1] = rgb[1]; pixels[index + 2] = rgb[2]; pixels[index + 3] = 255;
	};
	for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) put(x, y, background);
	lines.forEach((line, row) => {
		for (let column = 0; column < line.length; column++) {
			if (line[column] === " ") continue;
			for (let dy = 1; dy < cellHeight - 1; dy++) for (let dx = 1; dx < cellWidth - 1; dx++) put(column * cellWidth + dx, row * cellHeight + dy, foreground);
		}
	});
	return { width, height, pixels };
}
