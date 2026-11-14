import { dyno } from "@sparkjsdev/spark";
import * as THREE from "three";

type Outline = { outer: number[][] };

// Scan-space square (x and z) the footprint masks cover, wide enough for every slice
const MASK_MIN = -8;
const MASK_SIZE = 16;
const MASK_RES = 512;
// The footprint is grown a little so outer walls stay, then feathered so its edge fades instead of cutting
const FOOTPRINT_GROW = 0.03;
const FOOTPRINT_FEATHER = 0.1;
// Scan haze is large, faint splats: past HAZE_SCALE (largest axis, scan units) a splat must be fairly opaque to stay
const HAZE_SCALE: [number, number] = [0.02, 0.06];
const HAZE_OPACITY: [number, number] = [0.15, 0.5];

/** White inside the slice's outlines, black outside, with a soft edge; texel (u, v) maps to scan (x, z). */
const footprintMask = (outlines: Outline[]) => {
	const px = MASK_RES / MASK_SIZE;
	const shape = document.createElement("canvas");
	shape.width = shape.height = MASK_RES;
	const g = shape.getContext("2d")!;
	g.fillStyle = g.strokeStyle = "#fff";
	g.lineJoin = "round";
	g.lineWidth = FOOTPRINT_GROW * 2 * px;
	for (const { outer } of outlines) {
		g.beginPath();
		outer.forEach(([x, z], i) => g[i ? "lineTo" : "moveTo"]((x - MASK_MIN) * px, (z - MASK_MIN) * px));
		g.closePath();
		g.fill();
		g.stroke();
	}
	const soft = document.createElement("canvas");
	soft.width = soft.height = MASK_RES;
	const s = soft.getContext("2d")!;
	s.filter = `blur(${(FOOTPRINT_FEATHER * px) / 2}px)`;
	s.drawImage(shape, 0, 0);
	const texture = new THREE.CanvasTexture(soft);
	texture.flipY = false;
	texture.generateMipmaps = false;
	texture.minFilter = THREE.LinearFilter;
	return texture;
};

/**
 * Cleans a slice of the scan before it is drawn: splats floating outside the slice's footprint (fog off the glass,
 * stray points past the walls) fade out, and large faint splats, the haze that blurs edges, are dropped.
 */
export const createHazeModifier = (outlines: Outline[]) => {
	const mask = dyno.dynoSampler2D(footprintMask(outlines));
	const fade = new dyno.Dyno({
		inTypes: { gsplat: dyno.Gsplat, mask: "sampler2D" },
		outTypes: { gsplat: dyno.Gsplat },
		statements: ({ inputs, outputs }) =>
			dyno.unindentLines(`
				${outputs.gsplat} = ${inputs.gsplat};
				vec2 uv = (${inputs.gsplat}.center.xz - ${MASK_MIN.toFixed(1)}) / ${MASK_SIZE.toFixed(1)};
				float inside = smoothstep(0.05, 0.6, texture(${inputs.mask}, uv).r);
				vec3 s = ${inputs.gsplat}.scales;
				float large = smoothstep(${HAZE_SCALE[0]}, ${HAZE_SCALE[1]}, max(s.x, max(s.y, s.z)));
				float a = ${inputs.gsplat}.rgba.a;
				a *= mix(1.0, smoothstep(${HAZE_OPACITY[0]}, ${HAZE_OPACITY[1]}, a), large);
				${outputs.gsplat}.rgba.a = a * inside;
			`)
	});
	return {
		modifier: dyno.dynoBlock({ gsplat: dyno.Gsplat }, { gsplat: dyno.Gsplat }, ({ gsplat }) => ({
			gsplat: fade.apply({ gsplat, mask }).gsplat
		})),
		dispose: () => mask.value.dispose()
	};
};
