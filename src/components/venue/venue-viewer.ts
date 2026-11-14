import { SparkRenderer, SplatEdit, SplatEditRgbaBlendMode, SplatEditSdf, SplatEditSdfType, SplatMesh } from "@sparkjsdev/spark";
import gsap from "gsap";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import floorOutlines from "./floor-outlines.json";
import { createHazeModifier } from "./haze-modifier";
import { createKuwaharaPass } from "./kuwahara-pass";
import { createTrees } from "./trees";

// Gaussian-splat scan of the venue, cut into horizontal slices (scan frame: y up), see public/models/venue/
const MODEL_BASE = "/models/venue";
// Phones get ~35% of the splats: the full set is ~1.5M per view, past what mobile GPUs and sorters keep up with
const SPLAT_BASE = () => (isConstrainedViewport() ? `${MODEL_BASE}/lite` : MODEL_BASE);
export const FLOOR_IDS = ["2f", "3f", "4f"] as const;
export type FloorId = (typeof FLOOR_IDS)[number];
// Vertical range of each slice in scan units; must match the crop the .sog files were cut with.
// Each slice stops below its ceiling so every floor reads from above. The slab between two floors ships with the
// upper slice (outside R0), hidden under its floor sheet, so a floor drawn above the one below joins it without a seam.
// 2F also carries the upper half of the curved entrance glass, which rises through 3F.
const FLOOR_LEVELS: Record<FloorId, [number, number]> = {
	"2f": [-1.6, -0.78],
	"3f": [-0.55, -0.1],
	"4f": [0.2, 0.6]
};
// R0 is a raked hall spanning 3F and 4F, so it is cut out of both slices and shipped as its own
// full-height chunk that shows whenever 3F or 4F does
const R0_CHUNK = "r0" as const;
const R0_FLOORS: readonly FloorId[] = ["3f", "4f"];
// Floors are open to the ones below (R0's double height, voids, scan gaps), so every floor beneath stays drawn:
// looking down through a floor lands on the one below rather than on the page background
const FLOOR_BENEATH: Record<FloorId, readonly FloorId[]> = { "2f": [], "3f": ["2f"], "4f": ["3f", "2f"] };
// R0's floor: a flat stage at the front, then a rake rising towards the back. Must match the crop,
// which keeps everything from R0_CROP_DEPTH under this floor upwards.
const R0_STAGE_Y = -0.35;
const R0_STAGE_EDGE = 0.9;
const R0_RAKE = 0.205;
const R0_CROP_DEPTH = 0.04;
// Behind R0's top row the floor steps down to the 4F floor's height, under the rake crop, so the chunk carries it
// separately from the source scan. The floor map there shows the booth's roof, so the rake sheet ends at the top row
// and the 3F sheet below turns plain dark.
const R0_TOP_ROW_Z = -2.3;
const R0_BACK_FLOOR_COLOR = "#504638";
const r0FloorY = (z: number) => R0_STAGE_Y + Math.max(0, R0_STAGE_EDGE - z) * R0_RAKE;
type ChunkId = FloorId | typeof R0_CHUNK;
const CHUNK_IDS: readonly ChunkId[] = [...FLOOR_IDS, R0_CHUNK];
const MODEL_SCALE = 0.8;
const MODEL_YAW = THREE.MathUtils.degToRad(111.3);
// Centre of the building in scan units
const MODEL_CENTER = new THREE.Vector3(0.5, -0.4, -0.3);

// Room models include the walls, cropped this far outside the room outline (scan units); must match the crop
const ROOM_MARGIN = 0.18;
// A wall facing the camera is hidden from just inside its inner face outward
const WALL_INSET = 0.03;
// Zooming out past this multiple of a room's framing distance leaves the room
const ROOM_EXIT_ZOOM = 1.6;

/** Grow a convex polygon outward by `d` (each edge moves out along its normal). */
const offsetPolygon = (polygon: number[][], d: number) => {
	const cx = polygon.reduce((sum, [x]) => sum + x, 0) / polygon.length;
	const cz = polygon.reduce((sum, [, z]) => sum + z, 0) / polygon.length;
	const lines = polygon.map(([x0, z0], i) => {
		const [x1, z1] = polygon[(i + 1) % polygon.length];
		let nx = z1 - z0;
		let nz = -(x1 - x0);
		const len = Math.hypot(nx, nz);
		nx /= len;
		nz /= len;
		if (nx * ((x0 + x1) / 2 - cx) + nz * ((z0 + z1) / 2 - cz) < 0) [nx, nz] = [-nx, -nz];
		return { px: x0 + nx * d, pz: z0 + nz * d, dx: x1 - x0, dz: z1 - z0 };
	});
	return lines.map((b, i) => {
		const a = lines[(i - 1 + lines.length) % lines.length];
		const det = a.dx * b.dz - a.dz * b.dx;
		if (Math.abs(det) < 1e-9) return [b.px, b.pz];
		const t = ((b.px - a.px) * b.dz - (b.pz - a.pz) * b.dx) / det;
		return [a.px + a.dx * t, a.pz + a.dz * t];
	});
};

// Unselected areas fade towards the page background rather than going dark
const DIM_OPACITY = 0.16;
const HOVER_TINT = new THREE.Color(1.12, 1.08, 1.0);
// Solid floor slabs sit just under the scanned floor and only show through where the scan has gaps.
// They are textured with a colour map baked from the scanned floor itself (public/models/venue/floors/),
// so what shows through matches the floor around it instead of reading as light patches.
// The maps cover this rectangle of the scan (x, z), image top at max z.
const FLOOR_MAP_BOUNDS = { x0: -7, x1: 8, z0: -6.5, z1: 6.5 };

export const isFloorId = (id: string): id is FloorId => (FLOOR_IDS as readonly string[]).includes(id);

/**
 * Footprint of a room or counter in scan units (x, z), from venue.json:
 * a convex `polygon` traced along its walls, or `boxes` of `[centerX, centerZ, halfX, halfZ, yawDegrees]`.
 * An area with its own height range `y` is R0, which lives in the R0 chunk.
 * `screen` (x, z) is where a session room's projection screen is; selecting the room looks at it from the back rows.
 * `view` fine-tunes that shot per room: `[back, up, aim]`, multiples of the screen-to-centre distance for how far behind
 * and how high the camera sits, and where it aims between the screen (0) and the room centre (1).
 * `room` is the height range of the room's own full-height, full-density model (public/models/venue/rooms/<model>.sog),
 * shown in place of the floor slice while the room is selected.
 * `ceiling` is `[height at the screen, rise per unit towards the back]` for a room whose ceiling is not level (R0);
 * otherwise the ceiling is taken as just under the top of `room`.
 */
export type AreaShape = {
	polygon?: number[][];
	boxes?: number[][];
	y?: number[];
	screen?: number[];
	view?: number[];
	room?: number[];
	ceiling?: number[];
};
export type AreaDef = { id: string; floor: FloorId; area: AreaShape; model?: string };

export type ViewerInsets = { left: number; top: number; bottom: number };

export type VenueViewerOptions = {
	canvas: HTMLCanvasElement;
	areas: AreaDef[];
	initialFloor: FloorId;
	/** Screen space covered by UI, so the model is framed in what is left. */
	getInsets: () => ViewerInsets;
	onAreaClick: (id: string | null) => void;
	onHover: (hit: { id: string; x: number; y: number } | null) => void;
	onProgress: (loaded: number, total: number) => void;
};

/** A footprint placed in one chunk, with invisible meshes for picking. */
type Region = { pivot: THREE.Group; shape: AreaShape; range: number[]; picks: THREE.Mesh[]; size: number };
type Area = AreaDef & { region: Region; floorY: (z: number) => number };
/** A wall of a room model that can be cut away: an outward-facing plane SDF hiding everything beyond it. */
type Wall = { sdf: SplatEditSdf; mid: THREE.Vector3; normal: THREE.Vector3 };
type RoomModel = {
	splat: SplatMesh;
	backing: THREE.Mesh | null;
	walls: Wall[];
	ceiling: SplatEditSdf;
	ceilingAt: (x: number, z: number) => number;
	cut: string;
};

const prefersReducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const isConstrainedViewport = () => window.matchMedia("(max-width: 768px), (pointer: coarse)").matches;

/** A floor sheet of `outlines` (scan x, z, each with its holes) at height `top`. Shape space is (x, -z) so it faces up. */
const createSlab = (outlines: { outer: number[][]; holes: number[][][] }[], top: number, material: THREE.Material) => {
	const toPath = <T extends THREE.Path>(points: number[][], path: T) => {
		points.forEach(([x, z], i) => (i ? path.lineTo(x, -z) : path.moveTo(x, -z)));
		path.closePath();
		return path;
	};
	const shapes = outlines.map(({ outer, holes }) => {
		const shape = toPath(outer, new THREE.Shape());
		shape.holes = holes.map(hole => toPath(hole, new THREE.Path()));
		return shape;
	});
	// A flat sheet: unlit and textured, it needs no thickness (and extruded sides would sample off the map)
	const slab = new THREE.Mesh(new THREE.ShapeGeometry(shapes), material);
	slab.rotation.x = -Math.PI / 2;
	slab.position.y = top;
	return slab;
};

/** Clip a polygon (scan x, z) to the side of the line z = `edge` where `keep` holds (Sutherland–Hodgman). */
const clipAtZ = (points: number[][], edge: number, keep: (z: number) => boolean) => {
	const out: number[][] = [];
	points.forEach((p, i) => {
		const q = points[(i + 1) % points.length];
		if (keep(p[1])) out.push(p);
		if (keep(p[1]) !== keep(q[1])) out.push([p[0] + ((q[0] - p[0]) * (edge - p[1])) / (q[1] - p[1]), edge]);
	});
	return out;
};

/**
 * R0's rake sheet: `outline` (scan x, z) laid on the stage and rake just under the R0 chunk's crop, so gaps in the
 * scanned seating show floor at the seats' own depth instead of the 3F sheet a whole storey below.
 * It levels off at `top` (the 4F floor) for the top rows and ends behind the top row.
 * Cut at every bend, each band is planar, so its outline vertices place it exactly.
 */
const createRakeSlab = (outline: number[][], top: number, material: THREE.Material) => {
	const height = (z: number) => Math.min(r0FloorY(z) - R0_CROP_DEPTH, top);
	// Where the rake reaches `top`
	const crest = R0_STAGE_EDGE - (top + R0_CROP_DEPTH - R0_STAGE_Y) / R0_RAKE;
	const bands = [
		[R0_STAGE_EDGE, Infinity],
		[crest, R0_STAGE_EDGE],
		[R0_TOP_ROW_Z, crest]
	];
	const group = new THREE.Group();
	for (const [z0, z1] of bands) {
		let part = clipAtZ(outline, z0, z => z >= z0);
		if (z1 < Infinity) part = clipAtZ(part, z1, z => z <= z1);
		if (part.length < 3) continue;
		const geometry = new THREE.ShapeGeometry(new THREE.Shape(part.map(([x, z]) => new THREE.Vector2(x, -z))));
		const position = geometry.attributes.position;
		for (let i = 0; i < position.count; i++) {
			const z = -position.getY(i);
			position.setXYZ(i, position.getX(i), height(z), z);
		}
		geometry.computeBoundingSphere();
		group.add(new THREE.Mesh(geometry, material));
	}
	return group;
};

export const createVenueViewer = (options: VenueViewerOptions) => {
	const { canvas } = options;
	const scene = new THREE.Scene();
	const splatBase = SPLAT_BASE();

	const rect = canvas.getBoundingClientRect();
	const camera = new THREE.PerspectiveCamera(45, rect.width / rect.height, 0.05, 200);
	camera.position.set(-10, 8, 10);

	// Splats are blended, not rasterised as triangles, so MSAA only costs fill rate.
	// The canvas is transparent so the page background shows through.
	const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: true, premultipliedAlpha: true });
	renderer.setClearColor(0x000000, 0);
	// The painterly pass reads an elliptical neighbourhood per pixel, so keep the buffer modest
	const pixelRatio = () => Math.min(window.devicePixelRatio, isConstrainedViewport() ? 1 : 1.25);
	// Brush radius in drawing-buffer pixels; the pass costs ~radius², and phones show the frame small anyway
	const brushRadius = () => (isConstrainedViewport() ? 3 : 5) * pixelRatio();
	renderer.setPixelRatio(pixelRatio());
	renderer.setSize(rect.width, rect.height, false);
	scene.add(new SparkRenderer({ renderer }));
	const kuwahara = createKuwaharaPass(renderer);
	kuwahara.setSize(renderer.domElement.width, renderer.domElement.height, brushRadius());

	const controls = new OrbitControls(camera, renderer.domElement);
	controls.enableDamping = true;
	controls.dampingFactor = 0.06;
	controls.minDistance = 1;
	controls.maxDistance = 30;
	controls.maxPolarAngle = Math.PI / 2.1;

	const modelGroup = new THREE.Group();
	modelGroup.rotation.y = MODEL_YAW;
	modelGroup.scale.setScalar(MODEL_SCALE);
	scene.add(modelGroup);
	const content = new THREE.Group();
	content.position.copy(MODEL_CENTER).negate();
	modelGroup.add(content);
	const trees = createTrees();
	// Holder so being inside a room can hide the trees without fighting the dim fade over trees.group.visible
	const treeLayer = new THREE.Group().add(trees.group);
	content.add(treeLayer);

	const pickMaterial = new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide });
	// One unlit, colour-mapped material per slice; shape UVs are scan (x, -z), remapped onto the map's rectangle
	const textureLoader = new THREE.TextureLoader();
	const floorMaterials = new Map<FloorId, THREE.MeshBasicMaterial>(
		FLOOR_IDS.map(id => {
			const map = textureLoader.load(`${MODEL_BASE}/floors/floor-${id}.webp`);
			map.colorSpace = THREE.SRGBColorSpace;
			const { x0, x1, z0, z1 } = FLOOR_MAP_BOUNDS;
			map.repeat.set(1 / (x1 - x0), -1 / (z1 - z0));
			map.offset.set(-x0 / (x1 - x0), -z0 / (z1 - z0));
			map.wrapS = map.wrapT = THREE.ClampToEdgeWrapping;
			return [id, new THREE.MeshBasicMaterial({ map, side: THREE.DoubleSide })];
		})
	);
	// One haze modifier per footprint: each floor slice, R0 (spanning 3F and 4F), and the rooms inside a floor
	const hazeModifiers = new Map<FloorId | typeof R0_CHUNK, ReturnType<typeof createHazeModifier>>();
	const hazeModifier = (key: FloorId | typeof R0_CHUNK) => {
		if (!hazeModifiers.has(key)) {
			const floors = isFloorId(key) ? [key] : R0_FLOORS;
			hazeModifiers.set(key, createHazeModifier(floors.flatMap(floor => floorOutlines[floor].outlines)));
		}
		return hazeModifiers.get(key)!.modifier;
	};
	const pivots = new Map<ChunkId, THREE.Group>();
	const splats = new Map<ChunkId, SplatMesh>();
	let loaded = 0;
	let disposed = false;

	const holeEdit = new SplatEdit({ rgbaBlendMode: SplatEditRgbaBlendMode.MULTIPLY, softEdge: 0.04, sdfs: [] });
	const holeState = { opacity: 1 };

	const r0Hole = floorOutlines["3f"].outlines[0].holes[0];
	const r0FloorSheetY = floorOutlines["3f"].y;
	const r0BackMaterial = new THREE.MeshBasicMaterial({ color: R0_BACK_FLOOR_COLOR, side: THREE.DoubleSide });
	CHUNK_IDS.forEach(id => {
		const pivot = new THREE.Group();
		content.add(pivot);
		pivots.set(id, pivot);

		const splat = new SplatMesh({ url: `${splatBase}/${id}.sog`, objectModifier: hazeModifier(id) });
		splat.opacity = 0;
		// Local to the base slices: digs out the selected room where its own model takes over
		splat.edits = [holeEdit];
		pivot.add(splat);
		splats.set(id, splat);
		if (isFloorId(id)) {
			const { y, outlines } = floorOutlines[id];
			// Outlines follow the scanned floor, so they already leave R0 (open from 3F up through 4F) out
			pivot.add(createSlab(outlines, y, floorMaterials.get(id)!));
		} else {
			// R0's own floor, filling the hole the 3F outline leaves: a flat 3F sheet catching every view under the rake
			// (plain dark behind the top row), and the rake sheet along the seating itself
			const front = clipAtZ(r0Hole, R0_TOP_ROW_Z, z => z >= R0_TOP_ROW_Z);
			const back = clipAtZ(r0Hole, R0_TOP_ROW_Z, z => z <= R0_TOP_ROW_Z);
			pivot.add(createSlab([{ outer: front, holes: [] }], r0FloorSheetY, floorMaterials.get("3f")!));
			pivot.add(createSlab([{ outer: back, holes: [] }], r0FloorSheetY, r0BackMaterial));
			pivot.add(createRakeSlab(r0Hole, floorOutlines["4f"].y, floorMaterials.get("3f")!));
		}

		splat.initialized.then(() => {
			if (disposed) return;
			options.onProgress(++loaded, CHUNK_IDS.length);
			if (pivot.visible) gsap.to(splat, { opacity: 1, duration: prefersReducedMotion() ? 0 : 1, ease: "power2.out" });
		});
	});
	options.onProgress(0, CHUNK_IDS.length);

	const makeRegion = (pivot: THREE.Group, shape: AreaShape, range: number[]): Region => {
		const [y0, y1] = range;
		const picks: THREE.Mesh[] = [];
		let size = 0;
		if (shape.polygon) {
			// Extrude the footprint downward from the top of the range (local Y of the shape becomes world Z)
			const outline = new THREE.Shape(shape.polygon.map(([x, z]) => new THREE.Vector2(x, z)));
			const pick = new THREE.Mesh(new THREE.ExtrudeGeometry(outline, { depth: y1 - y0, bevelEnabled: false }), pickMaterial);
			pick.rotation.x = Math.PI / 2;
			pick.position.y = y1;
			picks.push(pick);
			size += Math.abs(THREE.ShapeUtils.area(outline.getPoints()));
		}
		for (const [cx, cz, hx, hz, yaw = 0] of shape.boxes ?? []) {
			const pick = new THREE.Mesh(new THREE.BoxGeometry(hx * 2, y1 - y0, hz * 2), pickMaterial);
			pick.position.set(cx, (y0 + y1) / 2, cz);
			pick.rotation.y = THREE.MathUtils.degToRad(yaw);
			picks.push(pick);
			size += 4 * hx * hz;
		}
		picks.forEach(pick => pivot.add(pick));
		return { pivot, shape, range, picks, size };
	};

	const areas: Area[] = options.areas.map(def => {
		const ownRange = def.area.y?.length === 2;
		const slabY = floorOutlines[def.floor].y;
		return {
			...def,
			region: makeRegion(pivots.get(ownRange ? R0_CHUNK : def.floor)!, def.area, ownRange ? def.area.y! : FLOOR_LEVELS[def.floor]),
			floorY: ownRange ? r0FloorY : () => slabY
		};
	});

	const dimEdit = new SplatEdit({ rgbaBlendMode: SplatEditRgbaBlendMode.MULTIPLY, invert: true, softEdge: 0.06, sdfs: [] });
	dimEdit.visible = false;
	scene.add(dimEdit);
	const hoverEdit = new SplatEdit({ rgbaBlendMode: SplatEditRgbaBlendMode.MULTIPLY, softEdge: 0.04, sdfs: [] });
	hoverEdit.visible = false;
	scene.add(hoverEdit);
	const dimState = { factor: 1 };

	let currentFloor: FloorId = options.initialFloor;

	/**
	 * Point an edit at a region. SDFs only combine as a union, so a polygon is described by its outside:
	 * one half-space per edge, whose union is everything beyond the walls. Boxes are described by their inside.
	 * `target` says which side the edit should affect; the edit's invert flag bridges the two descriptions.
	 * SDFs are parented to the region's chunk so they share its transform.
	 */
	const aimEdit = (edit: SplatEdit, region: Region, target: "inside" | "outside", color: THREE.Color) => {
		clearSdfs(edit);
		const sdfs: SplatEditSdf[] = [];
		const midY = (region.range[0] + region.range[1]) / 2;
		const polygon = region.shape.polygon;
		if (polygon) {
			const cx = polygon.reduce((sum, [x]) => sum + x, 0) / polygon.length;
			const cz = polygon.reduce((sum, [, z]) => sum + z, 0) / polygon.length;
			polygon.forEach(([x0, z0], i) => {
				const [x1, z1] = polygon[(i + 1) % polygon.length];
				const outward = new THREE.Vector3(z1 - z0, 0, -(x1 - x0)).normalize();
				if (outward.x * ((x0 + x1) / 2 - cx) + outward.z * ((z0 + z1) / 2 - cz) < 0) outward.negate();
				// A plane SDF is negative on its local -Z side; face +Z inward so the negative side is outside this edge
				const sdf = new SplatEditSdf({ type: SplatEditSdfType.PLANE, color: color.clone() });
				sdf.position.set(x0, midY, z0);
				sdf.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), outward.negate());
				sdfs.push(sdf);
			});
			edit.invert = target === "inside";
		} else {
			for (const [cx, cz, hx, hz, yaw = 0] of region.shape.boxes ?? []) {
				const sdf = new SplatEditSdf({ type: SplatEditSdfType.BOX, color: color.clone() });
				sdf.position.set(cx, midY, cz);
				sdf.rotation.y = THREE.MathUtils.degToRad(yaw);
				// Box SDF reads its half extents from scale
				sdf.scale.set(hx, (region.range[1] - region.range[0]) / 2 + 0.3, hz);
				sdfs.push(sdf);
			}
			edit.invert = target === "outside";
		}
		sdfs.forEach(sdf => region.pivot.add(sdf));
		edit.sdfs = sdfs;
	};

	const clearSdfs = (edit: SplatEdit) => {
		edit.sdfs?.forEach(sdf => sdf.removeFromParent());
		edit.sdfs = [];
	};

	const applyDim = () => {
		dimEdit.sdfs?.forEach(sdf => (sdf.opacity = dimState.factor));
		dimEdit.visible = dimState.factor < 0.999 && (dimEdit.sdfs?.length ?? 0) > 0;
		trees.setOpacity(dimState.factor);
	};

	// ── Room mode: a selected room's own model replaces the floor slice there ──
	const roomModels = new Map<string, RoomModel>();
	let activeRoom: { area: Area; model: RoomModel } | null = null;

	const applyHole = () => holeEdit.sdfs?.forEach(sdf => (sdf.opacity = holeState.opacity));

	const loadRoomModel = (area: Area): RoomModel => {
		const cached = roomModels.get(area.model!);
		if (cached) return cached;
		const pivot = area.region.pivot;
		const splat = new SplatMesh({ url: `${splatBase}/rooms/${area.model}.sog`, objectModifier: hazeModifier(area.floor) });
		splat.opacity = 0;
		splat.visible = false;
		const cutaway = new SplatEdit({ rgbaBlendMode: SplatEditRgbaBlendMode.MULTIPLY, softEdge: 0.03, sdfs: [] });
		splat.edits = [cutaway];
		pivot.add(splat);

		const polygon = area.region.shape.polygon!;
		const [, y1] = area.region.shape.room!;
		const inner = offsetPolygon(polygon, -WALL_INSET);
		const cx = polygon.reduce((sum, [x]) => sum + x, 0) / polygon.length;
		const cz = polygon.reduce((sum, [, z]) => sum + z, 0) / polygon.length;
		const walls: Wall[] = inner.map(([x0, z0], i) => {
			const [x1, z1] = inner[(i + 1) % inner.length];
			const normal = new THREE.Vector3(z1 - z0, 0, -(x1 - x0)).normalize();
			if (normal.x * ((x0 + x1) / 2 - cx) + normal.z * ((z0 + z1) / 2 - cz) < 0) normal.negate();
			// Plane SDFs are negative on their local -Z side: face +Z inward so everything beyond the wall is negative
			const sdf = new SplatEditSdf({ type: SplatEditSdfType.PLANE, color: new THREE.Color(1, 1, 1), opacity: 0 });
			sdf.position.set(x0, y1, z0);
			sdf.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal.clone().negate());
			pivot.add(sdf);
			return { sdf, mid: new THREE.Vector3((x0 + x1) / 2, y1, (z0 + z1) / 2), normal };
		});
		// Ceiling: hide everything above a plane just under it, +Z facing down so the hidden side is above.
		// A sloped ceiling rises from the screen towards the back of the room.
		const [c0, slope] = area.region.shape.ceiling ?? [y1 - 0.1, 0];
		const [sx, sz] = area.region.shape.screen ?? [cx, cz];
		const back = new THREE.Vector2(cx - sx, cz - sz);
		if (back.lengthSq() < 1e-6) back.set(0, 1);
		back.normalize();
		const ceilingAt = (x: number, z: number) => c0 + slope * ((x - sx) * back.x + (z - sz) * back.y);
		const along = new THREE.Vector3(back.x, slope, back.y);
		const across = new THREE.Vector3(-back.y, 0, back.x);
		const down = new THREE.Vector3().crossVectors(along, across).normalize();
		if (down.y > 0) down.negate();
		const ceiling = new SplatEditSdf({ type: SplatEditSdfType.PLANE, color: new THREE.Color(1, 1, 1), opacity: 0 });
		ceiling.position.set(sx, c0, sz);
		ceiling.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), down);
		pivot.add(ceiling);

		// Backing in the floor's own colours, under the scanned floor (which stays on top) and over the slab,
		// ending at the wall line so it never pokes out past the walls
		// R0 gets none: its rake of seats covers the floor, and a sloped sheet only shows at the edges
		let backing: THREE.Mesh | null = null;
		if (!area.region.shape.y) {
			const shape = new THREE.Shape(polygon.map(([x, z]) => new THREE.Vector2(x, -z)));
			backing = new THREE.Mesh(new THREE.ShapeGeometry(shape), floorMaterials.get(area.floor)!);
			backing.rotation.x = -Math.PI / 2;
			backing.position.y = area.floorY(cz) + 0.02;
			backing.visible = false;
			pivot.add(backing);
		}

		const model: RoomModel = { splat, backing, walls, ceiling, ceilingAt, cut: "" };
		roomModels.set(area.model!, model);
		return model;
	};

	/** Sims-style cutaway: hide the walls whose outside faces the camera, and the ceiling when looking from above. */
	const local = new THREE.Vector3();
	const updateCutaway = () => {
		if (!activeRoom) {
			treeLayer.visible = true;
			return;
		}
		const { area, model } = activeRoom;
		area.region.pivot.worldToLocal(local.copy(camera.position));
		const cut = model.walls.map(wall => (local.clone().sub(wall.mid).dot(wall.normal) > 0 ? "1" : "0")).join("") + (local.y > model.ceilingAt(local.x, local.z) ? "c" : "");
		// Nothing cut away means the camera is inside the room, where the trees would only show through the walls
		treeLayer.visible = /[1c]/.test(cut);
		if (cut === model.cut) return;
		model.cut = cut;
		const edit = model.splat.edits![0];
		edit.sdfs = [...model.walls.filter((_, i) => cut[i] === "1").map(wall => wall.sdf), ...(cut.endsWith("c") ? [model.ceiling] : [])];
	};

	const enterRoom = (area: Area) => {
		const model = loadRoomModel(area);
		activeRoom = { area, model };
		model.cut = "";
		updateCutaway();
		// The slices give way inside the room and its walls once the room model is ready
		const hole = { pivot: area.region.pivot, shape: { polygon: offsetPolygon(area.region.shape.polygon!, ROOM_MARGIN) }, range: area.region.range, picks: [], size: 0 };
		aimEdit(holeEdit, hole, "inside", new THREE.Color(1, 1, 1));
		holeState.opacity = 1;
		applyHole();
		const reveal = () => {
			if (activeRoom?.model !== model) return;
			model.splat.visible = true;
			if (model.backing) model.backing.visible = true;
			const d = prefersReducedMotion() ? 0 : 0.6;
			gsap.to(model.splat, { opacity: 1, duration: d, ease: "power2.out" });
			gsap.to(holeState, { opacity: 0, duration: d, ease: "power2.out", onUpdate: applyHole });
		};
		if (model.splat.isInitialized) reveal();
		else model.splat.initialized.then(reveal);
	};

	const exitRoom = () => {
		roomExitDistance = Infinity;
		if (!activeRoom) return;
		const { model } = activeRoom;
		activeRoom = null;
		const d = prefersReducedMotion() ? 0 : 0.4;
		gsap.killTweensOf([model.splat, holeState]);
		gsap.to(holeState, {
			opacity: 1,
			duration: d,
			onUpdate: applyHole,
			onComplete: () => {
				if (activeRoom) return;
				clearSdfs(holeEdit);
				holeEdit.invert = false;
			}
		});
		gsap.to(model.splat, {
			opacity: 0,
			duration: d,
			onComplete: () => {
				if (activeRoom?.model === model) return;
				model.splat.visible = false;
				if (model.backing) model.backing.visible = false;
			}
		});
	};

	const clearSelection = () => {
		exitRoom();
		gsap.killTweensOf(dimState);
		if (!dimEdit.sdfs?.length) return;
		gsap.to(dimState, {
			factor: 1,
			duration: prefersReducedMotion() ? 0 : 0.4,
			ease: "power2.out",
			onUpdate: applyDim,
			onComplete: () => {
				clearSdfs(dimEdit);
				applyDim();
			}
		});
	};

	let hovered: Region | null = null;
	const setHover = (region: Region | null) => {
		if (region === hovered) return;
		hovered = region;
		if (region) aimEdit(hoverEdit, region, "inside", HOVER_TINT);
		else clearSdfs(hoverEdit);
		hoverEdit.visible = !!region;
	};

	/** Pull the camera back on narrow screens so the whole building still fits horizontally. */
	const fitDistance = (target: THREE.Vector3Like, position: THREE.Vector3Like) => {
		const k = camera.aspect < 1.2 ? Math.min(1.8, (1.2 / camera.aspect) ** 0.45) : 1;
		return { x: target.x + (position.x - target.x) * k, y: target.y + (position.y - target.y) * k, z: target.z + (position.z - target.z) * k };
	};

	const tweenCamera = (position: THREE.Vector3Like, target: THREE.Vector3Like, duration = 1, onComplete?: () => void) => {
		gsap.killTweensOf(camera.position);
		gsap.killTweensOf(controls.target);
		if (prefersReducedMotion()) {
			camera.position.set(position.x, position.y, position.z);
			controls.target.set(target.x, target.y, target.z);
			onComplete?.();
			return;
		}
		gsap.to(camera.position, { x: position.x, y: position.y, z: position.z, duration, ease: "power3.inOut", onComplete });
		gsap.to(controls.target, { x: target.x, y: target.y, z: target.z, duration, ease: "power3.inOut" });
	};

	/** Fade a slice in or out. */
	const setChunkVisible = (id: ChunkId, visible: boolean, duration: number) => {
		const pivot = pivots.get(id)!;
		const splat = splats.get(id)!;
		gsap.killTweensOf(splat);
		if (visible) pivot.visible = true;
		gsap.to(splat, {
			opacity: visible && splat.isInitialized ? 1 : 0,
			duration: prefersReducedMotion() ? 0 : duration,
			onComplete: () => {
				if (!visible) pivot.visible = false;
			}
		});
	};

	const showFloor = (floor: FloorId, instant = false) => {
		exitRoom();
		currentFloor = floor;
		setHover(null);
		const duration = instant ? 0 : 0.45;
		FLOOR_IDS.forEach(id => setChunkVisible(id, id === floor || FLOOR_BENEATH[floor].includes(id), duration));
		setChunkVisible(R0_CHUNK, R0_FLOORS.includes(floor), duration);
		const [y0, y1] = FLOOR_LEVELS[floor];
		const targetY = ((y0 + y1) / 2 - MODEL_CENTER.y) * MODEL_SCALE;
		const target = { x: 0, y: targetY, z: 0 };
		const position = fitDistance(target, { x: -6.5, y: targetY + 8, z: 6.5 });
		if (instant) {
			camera.position.set(position.x, position.y, position.z);
			controls.target.set(target.x, target.y, target.z);
		} else {
			tweenCamera(position, target);
		}
	};

	const zoomToRegion = (region: Region) => {
		const box = new THREE.Box3();
		region.picks.forEach(pick => box.expandByObject(pick));
		const center = box.getCenter(new THREE.Vector3());
		const size = box.getSize(new THREE.Vector3());
		const maxDim = Math.max(size.x, size.z, 2.2);
		const fov = camera.fov * (Math.PI / 180);
		const dist = (maxDim / 2 / Math.tan(fov / 2)) * 2.4;
		// Keep the current viewing direction so the camera glides instead of swinging around
		const dir = camera.position.clone().sub(controls.target).setY(0).normalize();
		const offset = dir.multiplyScalar(dist * 0.62).setY(dist * 0.78);
		tweenCamera(fitDistance(center, center.clone().add(offset)), center, 0.9, armRoomExit);
	};

	/**
	 * Look at a session room's screen from behind its back rows, slightly raised, the way an audience member would.
	 * Positions are worked out in the room's chunk (scan units) and then moved to world space.
	 */
	const viewScreen = (area: Area, screen: number[], view: number[] = []) => {
		const [backK = 2.1, upK = 1.6, aim = 0.45] = view;
		const polygon = area.region.shape.polygon ?? [];
		const cx = polygon.reduce((sum, [x]) => sum + x, 0) / polygon.length;
		const cz = polygon.reduce((sum, [, z]) => sum + z, 0) / polygon.length;
		const [sx, sz] = screen;
		const depth = Math.hypot(cx - sx, cz - sz);
		const back = new THREE.Vector2(cx - sx, cz - sz).normalize();
		// Aim a little in front of the screen so the stage and the front rows share the frame
		const tx = sx + back.x * depth * aim;
		const tz = sz + back.y * depth * aim;
		const target = new THREE.Vector3(tx, area.floorY(tz) + 0.12, tz);
		const position = new THREE.Vector3().copy(fitDistance(target, new THREE.Vector3(tx + back.x * depth * backK, target.y + depth * upK, tz + back.y * depth * backK)));
		// Orbit around the middle of the room rather than the aim point
		const centre = new THREE.Vector3(cx, area.floorY(cz) + 0.12, cz);
		area.region.pivot.localToWorld(centre);
		area.region.pivot.localToWorld(position);
		tweenCamera(position, centre, 1.1, armRoomExit);
	};

	// Zooming out well past a room's framing lets go of the room, the same as clicking outside it
	let roomExitDistance = Infinity;
	const armRoomExit = () => {
		if (activeRoom) roomExitDistance = camera.position.distanceTo(controls.target) * ROOM_EXIT_ZOOM;
	};
	controls.addEventListener("change", () => {
		if (!activeRoom || gsap.isTweening(camera.position) || camera.position.distanceTo(controls.target) <= roomExitDistance) return;
		roomExitDistance = Infinity;
		options.onAreaClick(null);
	});

	/** Light up an area, dim everything else, frame it. */
	const selectArea = (id: string) => {
		const area = areas.find(a => a.id === id);
		if (!area) return;
		gsap.killTweensOf(dimState);
		if (activeRoom && activeRoom.area !== area) exitRoom();
		// With a room model the walls belong to the room, so the dimmed outside starts beyond them
		const lit = area.model && area.region.shape.polygon ? { ...area.region, shape: { polygon: offsetPolygon(area.region.shape.polygon, ROOM_MARGIN + 0.05) } } : area.region;
		aimEdit(dimEdit, lit, "outside", new THREE.Color(1, 1, 1));
		if (area.model && area.region.shape.room) enterRoom(area);
		dimState.factor = 1;
		applyDim();
		gsap.to(dimState, { factor: DIM_OPACITY, duration: prefersReducedMotion() ? 0 : 0.6, ease: "power2.out", onUpdate: applyDim, onComplete: applyDim });
		if (area.region.shape.screen) viewScreen(area, area.region.shape.screen, area.region.shape.view);
		else zoomToRegion(area.region);
	};

	// ── Picking ────────────────────────────────────────────────────────────
	const raycaster = new THREE.Raycaster();
	const pointer = new THREE.Vector2();

	const isFullyVisible = (obj: THREE.Object3D): boolean => {
		for (let cur: THREE.Object3D | null = obj; cur; cur = cur.parent) if (!cur.visible) return false;
		return true;
	};

	const raycastFrom = (event: MouseEvent, targets: THREE.Object3D[]) => {
		const r = renderer.domElement.getBoundingClientRect();
		pointer.set(((event.clientX - r.left) / r.width) * 2 - 1, -((event.clientY - r.top) / r.height) * 2 + 1);
		raycaster.setFromCamera(pointer, camera);
		return raycaster.intersectObjects(targets.filter(isFullyVisible), false);
	};

	/** Area under the pointer on the current floor; nested areas win over the room around them. */
	const pickArea = (event: MouseEvent): Area | null => {
		const candidates = areas.filter(a => a.floor === currentFloor);
		let best: Area | null = null;
		for (const hit of raycastFrom(
			event,
			candidates.flatMap(a => a.region.picks)
		)) {
			const area = candidates.find(a => a.region.picks.includes(hit.object as THREE.Mesh));
			if (area && (!best || area.region.size < best.region.size)) best = area;
		}
		return best;
	};

	let pointerDown = { x: 0, y: 0 };
	const onPointerDown = (e: PointerEvent) => {
		pointerDown = { x: e.clientX, y: e.clientY };
	};

	const onClick = (event: MouseEvent) => {
		if (Math.hypot(event.clientX - pointerDown.x, event.clientY - pointerDown.y) > 5) return;
		options.onAreaClick(pickArea(event)?.id ?? null);
	};

	const onPointerMove = (event: PointerEvent) => {
		if (event.pointerType === "touch") return;
		wake();
		const area = pickArea(event);
		renderer.domElement.style.cursor = area ? "pointer" : "grab";
		setHover(area?.region ?? null);
		options.onHover(area ? { id: area.id, x: event.clientX, y: event.clientY } : null);
	};

	const onPointerLeave = () => {
		wake();
		setHover(null);
		options.onHover(null);
	};

	// ── Framing & loop ─────────────────────────────────────────────────────
	// A still frame is identical to the last one, so only draw while something moves. The tail covers damping
	// settling and Spark's asynchronous re-sort landing a frame or two after the camera stops.
	let drawUntil = 0;
	const wake = () => (drawUntil = performance.now() + 1200);
	controls.addEventListener("change", wake);
	const tweening = () => gsap.globalTimeline.getChildren(true, true, false).some(tween => tween.isActive());

	/** Shift the projection so the model is centred in the area the UI leaves free. */
	const updateViewOffset = () => {
		const W = renderer.domElement.width;
		const H = renderer.domElement.height;
		const scale = W / Math.max(1, renderer.domElement.clientWidth);
		const { left, top, bottom } = options.getInsets();
		camera.setViewOffset(W, H, Math.round((-left / 2) * scale), Math.round(((bottom - top) / 2) * scale), W, H);
		camera.updateProjectionMatrix();
		wake();
	};

	const resize = () => {
		const r = canvas.getBoundingClientRect();
		camera.aspect = r.width / r.height;
		renderer.setPixelRatio(pixelRatio());
		renderer.setSize(r.width, r.height, false);
		kuwahara.setSize(renderer.domElement.width, renderer.domElement.height, brushRadius());
		updateViewOffset();
	};

	let animationId = 0;
	let running = false;
	const frame = () => {
		if (!running) return;
		controls.update();
		if (tweening()) wake();
		if (performance.now() < drawUntil) {
			updateCutaway();
			kuwahara.render(scene, camera);
		}
		animationId = requestAnimationFrame(frame);
	};
	const start = () => {
		if (running || disposed) return;
		running = true;
		frame();
	};
	const stop = () => {
		running = false;
		cancelAnimationFrame(animationId);
	};
	const onVisibilityChange = () => (document.visibilityState === "visible" ? start() : stop());

	const resizeObserver = new ResizeObserver(resize);
	resizeObserver.observe(canvas);
	document.addEventListener("visibilitychange", onVisibilityChange);
	canvas.addEventListener("pointerdown", onPointerDown);
	canvas.addEventListener("click", onClick);
	canvas.addEventListener("pointermove", onPointerMove);
	canvas.addEventListener("pointerleave", onPointerLeave);

	showFloor(options.initialFloor, true);
	updateViewOffset();
	if (document.visibilityState === "visible") start();

	const dispose = () => {
		disposed = true;
		stop();
		resizeObserver.disconnect();
		trees.dispose();
		document.removeEventListener("visibilitychange", onVisibilityChange);
		canvas.removeEventListener("pointerdown", onPointerDown);
		canvas.removeEventListener("click", onClick);
		canvas.removeEventListener("pointermove", onPointerMove);
		canvas.removeEventListener("pointerleave", onPointerLeave);
		gsap.killTweensOf([dimState, camera.position, controls.target]);
		splats.forEach(splat => {
			gsap.killTweensOf(splat);
			splat.dispose();
		});
		roomModels.forEach(({ splat }) => {
			gsap.killTweensOf(splat);
			splat.dispose();
		});
		gsap.killTweensOf(holeState);
		pivots.forEach(pivot => {
			pivot.traverse(child => {
				if (child instanceof THREE.Mesh) child.geometry.dispose();
			});
		});
		hazeModifiers.forEach(haze => haze.dispose());
		kuwahara.dispose();
		floorMaterials.forEach(material => {
			material.map?.dispose();
			material.dispose();
		});
		r0BackMaterial.dispose();
		controls.dispose();
		renderer.dispose();
	};

	return {
		showFloor: (floor: FloorId) => showFloor(floor),
		selectArea,
		clearSelection,
		updateViewOffset,
		dispose
	};
};

export type VenueViewer = ReturnType<typeof createVenueViewer>;
