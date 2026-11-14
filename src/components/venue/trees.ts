import * as THREE from "three";
import treeData from "./trees.json";

/**
 * Low-poly trees around the building, placed from an aerial photo: [x, z, scale] in scan units, dense forest to the
 * north and east, a few on the lawn to the west.
 */
const TREES = treeData as [number, number, number][];

// The site slopes up from the 2F entrance road in the south (-z) to the forest in the north
const groundY = (z: number) => -1.3 + THREE.MathUtils.clamp((z + 5) / 11, 0, 1) * 0.8;

const FOLIAGE = ["#6f8a4a", "#7d9655", "#62803f", "#8aa05c", "#748f45", "#667f3e"].map(c => new THREE.Color(c));
// Trees further out fade into the page background, like the edges of the scan
const BACKGROUND = new THREE.Color("#eeede9");
const CENTER = { x: 0.5, z: -0.3 };
const fadeAt = (x: number, z: number) => THREE.MathUtils.smoothstep(Math.hypot(x - CENTER.x, z - CENTER.z), 7, 12.5) * 0.9;

export const createTrees = () => {
	const group = new THREE.Group();
	const rand = mulberry32(11);

	const material = new THREE.MeshLambertMaterial({ flatShading: true });
	const trunkMaterial = new THREE.MeshLambertMaterial();
	const crown = new THREE.IcosahedronGeometry(1, 1);
	const trunk = new THREE.CylinderGeometry(0.03, 0.045, 1, 5).translate(0, 0.5, 0);

	// Each tree is two overlapping crown lobes over a short trunk
	const crowns = new THREE.InstancedMesh(crown, material, TREES.length * 2);
	const trunks = new THREE.InstancedMesh(trunk, trunkMaterial, TREES.length);
	const m = new THREE.Matrix4();
	const q = new THREE.Quaternion();
	const color = new THREE.Color();
	const up = new THREE.Vector3(0, 1, 0);

	TREES.forEach(([x, z, s], i) => {
		const y = groundY(z);
		const height = 0.9 * s;
		const trunkHeight = height * 0.35;
		m.compose(new THREE.Vector3(x, y, z), q.identity(), new THREE.Vector3(1, trunkHeight, 1));
		trunks.setMatrixAt(i, m);

		const fade = fadeAt(x, z);
		trunks.setColorAt(i, color.set("#6a5640").lerp(BACKGROUND, fade));
		const base = FOLIAGE[Math.floor(rand() * FOLIAGE.length)];
		for (let k = 0; k < 2; k++) {
			const r = (k === 0 ? 0.34 : 0.24) * s;
			const offset = new THREE.Vector3((rand() - 0.5) * 0.18 * s, trunkHeight + r * (k === 0 ? 0.8 : 1.9), (rand() - 0.5) * 0.18 * s);
			q.setFromAxisAngle(up, rand() * Math.PI * 2);
			m.compose(offset.add(new THREE.Vector3(x, y, z)), q, new THREE.Vector3(r, r * (0.85 + rand() * 0.3), r));
			crowns.setMatrixAt(i * 2 + k, m);
			color.copy(base).offsetHSL((rand() - 0.5) * 0.03, 0, (rand() - 0.5) * 0.06 + (k === 1 ? 0.03 : 0));
			crowns.setColorAt(i * 2 + k, color.lerp(BACKGROUND, fade));
		}
	});
	crowns.computeBoundingSphere();
	trunks.computeBoundingSphere();
	group.add(trunks, crowns);

	// Only the trees are lit; splats and floor slabs use unlit materials
	const sun = new THREE.DirectionalLight("#fff1d6", 1.2);
	sun.position.set(-4, 10, 6);
	group.add(new THREE.HemisphereLight("#f4f6ff", "#8a8768", 1.5), sun);

	const setOpacity = (opacity: number) => {
		// Opaque at rest, so the trees write depth and the splats behind them are hidden; blended only while fading
		const transparent = opacity < 0.99;
		for (const mat of [material, trunkMaterial]) {
			if (mat.transparent !== transparent) mat.needsUpdate = true;
			mat.transparent = transparent;
			mat.depthWrite = !transparent;
			mat.opacity = opacity;
		}
		group.visible = opacity > 0.01;
	};
	setOpacity(1);

	const dispose = () => {
		crown.dispose();
		trunk.dispose();
		material.dispose();
		trunkMaterial.dispose();
	};

	return { group, setOpacity, dispose };
};

/** Small seeded PRNG so the trees look the same on every load. */
const mulberry32 = (seed: number) => () => {
	seed |= 0;
	seed = (seed + 0x6d2b79f5) | 0;
	let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
	t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
	return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
