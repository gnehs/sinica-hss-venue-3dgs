import { dyno } from "@sparkjsdev/spark";
import * as THREE from "three";

type Outline = { outer: number[][] };

// Scan-space square (x and z) the footprint masks cover, wide enough for every slice
const MASK_MIN = -8;
const MASK_SIZE = 16;
const MASK_RES = 512;
// Signed distance to the footprint edge is stored in [-SDF_RANGE, SDF_RANGE] scan units, positive inside
const SDF_RANGE = 0.25;
// A splat stays only while its body (its largest axis times EDGE_REACH) ends within EDGE_GROW past the outline,
// so the walls end in a clean cut instead of a fringe of splats spilling outward
const EDGE_GROW = 0.04;
const EDGE_REACH = 1.5;
// Scan haze is large, faint splats: past HAZE_SCALE (largest axis, scan units) a splat must be fairly opaque to stay
const HAZE_SCALE: [number, number] = [0.02, 0.06];
const HAZE_OPACITY: [number, number] = [0.15, 0.5];

/** Signed distance to the slice's outlines on a MASK_RES grid; texel (u, v) maps to scan (x, z). */
const footprintSdf = (outlines: Outline[]) => {
	const cell = MASK_SIZE / MASK_RES;
	const inside = document.createElement("canvas");
	inside.width = inside.height = MASK_RES;
	const g = inside.getContext("2d")!;
	g.fillStyle = "#fff";
	for (const { outer } of outlines) {
		g.beginPath();
		outer.forEach(([x, z], i) => g[i ? "lineTo" : "moveTo"]((x - MASK_MIN) / cell, (z - MASK_MIN) / cell));
		g.closePath();
		g.fill();
	}
	const fill = g.getImageData(0, 0, MASK_RES, MASK_RES).data;
	// Only texels within SDF_RANGE of an edge need a real distance, so each edge visits just its own neighbourhood
	const dist2 = new Float32Array(MASK_RES * MASK_RES).fill(SDF_RANGE * SDF_RANGE);
	const texelOf = (v: number) => (v - MASK_MIN) / cell - 0.5;
	for (const { outer } of outlines) {
		outer.forEach(([x0, z0], n) => {
			const [x1, z1] = outer[(n + 1) % outer.length];
			const dx = x1 - x0, dz = z1 - z0;
			const len2 = dx * dx + dz * dz || 1;
			const i0 = Math.max(0, Math.floor(texelOf(Math.min(x0, x1) - SDF_RANGE)));
			const i1 = Math.min(MASK_RES - 1, Math.ceil(texelOf(Math.max(x0, x1) + SDF_RANGE)));
			const j0 = Math.max(0, Math.floor(texelOf(Math.min(z0, z1) - SDF_RANGE)));
			const j1 = Math.min(MASK_RES - 1, Math.ceil(texelOf(Math.max(z0, z1) + SDF_RANGE)));
			for (let j = j0; j <= j1; j++) {
				const z = MASK_MIN + (j + 0.5) * cell;
				for (let i = i0; i <= i1; i++) {
					const x = MASK_MIN + (i + 0.5) * cell;
					const t = Math.max(0, Math.min(1, ((x - x0) * dx + (z - z0) * dz) / len2));
					const ex = x0 + t * dx - x, ez = z0 + t * dz - z;
					const k = j * MASK_RES + i;
					dist2[k] = Math.min(dist2[k], ex * ex + ez * ez);
				}
			}
		});
	}
	const data = new Uint8Array(MASK_RES * MASK_RES * 4);
	for (let k = 0; k < dist2.length; k++) {
		const d = Math.sqrt(dist2[k]) * (fill[k * 4] > 127 ? 1 : -1);
		data[k * 4] = Math.round(((d / SDF_RANGE) * 0.5 + 0.5) * 255);
		data[k * 4 + 3] = 255;
	}
	const texture = new THREE.DataTexture(data, MASK_RES, MASK_RES);
	texture.minFilter = texture.magFilter = THREE.LinearFilter;
	texture.needsUpdate = true;
	return texture;
};

export const createHazeModifier = (outlines: Outline[]) => {
	const mask = dyno.dynoSampler2D(footprintSdf(outlines));
	const fade = new dyno.Dyno({
		inTypes: { gsplat: dyno.Gsplat, mask: "sampler2D" },
		outTypes: { gsplat: dyno.Gsplat },
		statements: ({ inputs, outputs }) =>
			dyno.unindentLines(`
				${outputs.gsplat} = ${inputs.gsplat};
				vec2 uv = (${inputs.gsplat}.center.xz - ${MASK_MIN.toFixed(1)}) / ${MASK_SIZE.toFixed(1)};
				float sd = (texture(${inputs.mask}, uv).r * 2.0 - 1.0) * ${SDF_RANGE.toFixed(2)};
				vec3 s = ${inputs.gsplat}.scales;
				float smax = max(s.x, max(s.y, s.z));
				float inside = step(smax * ${EDGE_REACH.toFixed(2)}, sd + ${EDGE_GROW.toFixed(2)});
				float large = smoothstep(${HAZE_SCALE[0]}, ${HAZE_SCALE[1]}, smax);
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
