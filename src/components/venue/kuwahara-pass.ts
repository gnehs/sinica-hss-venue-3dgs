import * as THREE from "three";

/**
 * Painterly post-process in the style of digital plein-air painting:
 *  1. structure tensor of the frame (Sobel), smoothed with a separable Gaussian, gives each pixel a stroke direction;
 *  2. anisotropic Kuwahara filter (Kyprianidis et al., polynomial weights): an elliptical brush stretched along that
 *     direction, split into 8 sectors and blended by flatness, so strokes follow roof tiles, rows of seats and walls
 *     while edges stay crisp;
 *  3. a light grade (saturation, S-curve contrast, warm highlights / cool shadows) and a faint grain streaked along
 *     the stroke direction, like bristle marks.
 * Colour stays premultiplied so the canvas can remain transparent over the page background.
 */

const header = /* glsl */ `
	precision highp float;
	in vec2 vUv;
	out vec4 outColor;
`;

const vertexShader = /* glsl */ `
	precision highp float;
	in vec3 position;
	in vec2 uv;
	out vec2 vUv;
	void main() {
		vUv = uv;
		gl_Position = vec4(position.xy, 0.0, 1.0);
	}
`;

/** Structure tensor (E, F, G) of the straight (un-premultiplied) colour, via Sobel. */
const tensorShader = /* glsl */ `${header}
	uniform sampler2D tInput;
	uniform vec2 texel;

	vec3 at(vec2 o) {
		vec4 c = texture(tInput, vUv + o * texel);
		return c.a > 0.0 ? c.rgb / c.a : vec3(0.0);
	}

	void main() {
		vec3 tl = at(vec2(-1, 1)), t = at(vec2(0, 1)), tr = at(vec2(1, 1));
		vec3 l = at(vec2(-1, 0)), r = at(vec2(1, 0));
		vec3 bl = at(vec2(-1, -1)), b = at(vec2(0, -1)), br = at(vec2(1, -1));
		vec3 gx = (tr + 2.0 * r + br - tl - 2.0 * l - bl) * 0.25;
		vec3 gy = (tl + 2.0 * t + tr - bl - 2.0 * b - br) * 0.25;
		outColor = vec4(dot(gx, gx), dot(gx, gy), dot(gy, gy), 1.0);
	}
`;

/** Separable Gaussian on the tensor so stroke directions flow smoothly across the frame. */
const blurShader = /* glsl */ `${header}
	uniform sampler2D tInput;
	uniform vec2 dir;

	void main() {
		const float sigma = 2.5;
		vec4 sum = vec4(0.0);
		float wsum = 0.0;
		for (int i = -7; i <= 7; i++) {
			float w = exp(-float(i * i) / (2.0 * sigma * sigma));
			sum += texture(tInput, vUv + dir * float(i)) * w;
			wsum += w;
		}
		outColor = sum / wsum;
	}
`;

const paintShader = /* glsl */ `${header}
	uniform sampler2D tInput;
	uniform sampler2D tTensor;
	uniform vec2 texel;
	uniform float radius;

	const int SECTORS = 8;
	const float ALPHA = 1.0;
	const float Q = 8.0;
	const float ZETA = 0.33;
	const float ETA = 0.84;

	float hash(vec2 p) {
		return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
	}

	float noise(vec2 p) {
		vec2 i = floor(p), f = fract(p);
		f = f * f * (3.0 - 2.0 * f);
		return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
	}

	vec3 toSrgb(vec3 c) {
		return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
	}

	void main() {
		vec3 g = texture(tTensor, vUv).xyz;
		float root = sqrt(max((g.x - g.z) * (g.x - g.z) + 4.0 * g.y * g.y, 0.0));
		float lambda1 = 0.5 * (g.x + g.z + root);
		float lambda2 = 0.5 * (g.x + g.z - root);
		vec2 v = vec2(lambda1 - g.x, -g.y);
		vec2 t = length(v) > 1e-8 ? normalize(v) : vec2(0.0, 1.0);
		float phi = -atan(t.y, t.x);
		float anisotropy = lambda1 + lambda2 > 1e-8 ? (lambda1 - lambda2) / (lambda1 + lambda2) : 0.0;

		// Elliptical brush: long along the edge, short across it
		float a = radius * clamp((ALPHA + anisotropy) / ALPHA, 0.1, 2.0);
		float b = radius * clamp(ALPHA / (ALPHA + anisotropy), 0.1, 2.0);
		float cp = cos(phi), sp = sin(phi);
		mat2 SR = mat2(cp / a, -sp / b, sp / a, cp / b);
		int maxX = int(ceil(sqrt(a * a * cp * cp + b * b * sp * sp)));
		int maxY = int(ceil(sqrt(a * a * sp * sp + b * b * cp * cp)));

		vec4 m[SECTORS];
		vec3 s[SECTORS];
		for (int k = 0; k < SECTORS; k++) { m[k] = vec4(0.0); s[k] = vec3(0.0); }

		for (int j = -maxY; j <= maxY; j++) {
			for (int i = -maxX; i <= maxX; i++) {
				vec2 u = SR * vec2(float(i), float(j));
				if (dot(u, u) > 1.0) continue;
				vec4 c = texture(tInput, vUv + vec2(float(i), float(j)) * texel);
				float gauss = exp(-3.0 * dot(u, u));

				// Polynomial sector weights (axis-aligned four, then the four diagonals)
				float w[SECTORS];
				float vxx = ZETA - ETA * u.x * u.x;
				float vyy = ZETA - ETA * u.y * u.y;
				float z;
				z = max(0.0, u.y + vxx); w[0] = z * z;
				z = max(0.0, -u.x + vyy); w[2] = z * z;
				z = max(0.0, -u.y + vxx); w[4] = z * z;
				z = max(0.0, u.x + vyy); w[6] = z * z;
				vec2 d = 0.70710678 * vec2(u.x - u.y, u.x + u.y);
				vxx = ZETA - ETA * d.x * d.x;
				vyy = ZETA - ETA * d.y * d.y;
				z = max(0.0, d.y + vxx); w[1] = z * z;
				z = max(0.0, -d.x + vyy); w[3] = z * z;
				z = max(0.0, -d.y + vxx); w[5] = z * z;
				z = max(0.0, d.x + vyy); w[7] = z * z;
				float wsum = 0.0;
				for (int k = 0; k < SECTORS; k++) wsum += w[k];
				if (wsum <= 0.0) continue;
				float norm = gauss / wsum;
				for (int k = 0; k < SECTORS; k++) {
					float wk = w[k] * norm;
					m[k] += vec4(c.rgb * wk, wk);
					s[k] += c.rgb * c.rgb * wk;
				}
			}
		}

		vec3 acc = vec3(0.0);
		float wacc = 0.0;
		for (int k = 0; k < SECTORS; k++) {
			if (m[k].w <= 0.0) continue;
			vec3 mean = m[k].rgb / m[k].w;
			vec3 var = abs(s[k] / m[k].w - mean * mean);
			float sigma2 = var.r + var.g + var.b;
			float wk = 1.0 / (1.0 + pow(2500.0 * sigma2, 0.5 * Q));
			acc += mean * wk;
			wacc += wk;
		}
		vec4 src = texture(tInput, vUv);
		vec3 premul = wacc > 0.0 ? acc / wacc : src.rgb;
		float alpha = src.a;
		vec3 col = alpha > 0.0 ? clamp(premul / max(alpha, 1e-4), 0.0, 1.0) : vec3(0.0);

		// Grade: richer colour, gentle S-curve, warm light and cool shade
		col = toSrgb(col);
		float luma = dot(col, vec3(0.299, 0.587, 0.114));
		col = mix(vec3(luma), col, 1.36);
		col = clamp(col, 0.0, 1.0);
		col = mix(col, col * col * (3.0 - 2.0 * col), 0.35);
		col += mix(vec3(-0.012, 0.0, 0.03), vec3(0.035, 0.012, -0.025), smoothstep(0.25, 0.8, luma));

		// Bristle grain: noise stretched along the stroke direction
		vec2 px = vUv / texel;
		vec2 along = vec2(t.y, -t.x);
		vec2 q = vec2(dot(px, along) * 0.08, dot(px, t) * 0.9);
		col += (noise(q) - 0.5) * 0.03 * anisotropy;

		outColor = vec4(clamp(col, 0.0, 1.0) * alpha, alpha);
	}
`;

export const createKuwaharaPass = (renderer: THREE.WebGLRenderer) => {
	const colorTarget = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: true });
	// Let three encode to sRGB while rendering into the target, the same as it would for the canvas
	colorTarget.texture.colorSpace = THREE.SRGBColorSpace;
	const tensorOptions = { depthBuffer: false, type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter };
	const tensorTarget = new THREE.WebGLRenderTarget(1, 1, tensorOptions);
	const blurTarget = new THREE.WebGLRenderTarget(1, 1, tensorOptions);

	const makeMaterial = (fragmentShader: string, uniforms: Record<string, THREE.IUniform>) =>
		new THREE.RawShaderMaterial({
			glslVersion: THREE.GLSL3,
			uniforms,
			vertexShader,
			fragmentShader,
			depthTest: false,
			depthWrite: false,
			blending: THREE.NoBlending
		});

	const texel = new THREE.Vector2();
	const tensorMaterial = makeMaterial(tensorShader, { tInput: { value: colorTarget.texture }, texel: { value: texel } });
	const blurX = makeMaterial(blurShader, { tInput: { value: tensorTarget.texture }, dir: { value: new THREE.Vector2() } });
	const blurY = makeMaterial(blurShader, { tInput: { value: blurTarget.texture }, dir: { value: new THREE.Vector2() } });
	const paintMaterial = makeMaterial(paintShader, {
		tInput: { value: colorTarget.texture },
		tTensor: { value: tensorTarget.texture },
		texel: { value: texel },
		radius: { value: 5 }
	});

	const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), tensorMaterial);
	const quadScene = new THREE.Scene();
	quadScene.add(quad);
	const quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

	const pass = (material: THREE.RawShaderMaterial, target: THREE.WebGLRenderTarget | null) => {
		quad.material = material;
		renderer.setRenderTarget(target);
		renderer.render(quadScene, quadCamera);
	};

	/** Size and brush radius, both in drawing-buffer pixels. */
	const setSize = (width: number, height: number, radius: number) => {
		colorTarget.setSize(width, height);
		tensorTarget.setSize(width, height);
		blurTarget.setSize(width, height);
		texel.set(1 / width, 1 / height);
		blurX.uniforms.dir.value.set(1 / width, 0);
		blurY.uniforms.dir.value.set(0, 1 / height);
		paintMaterial.uniforms.radius.value = radius;
	};

	const render = (scene: THREE.Scene, camera: THREE.Camera) => {
		renderer.setRenderTarget(colorTarget);
		renderer.clear();
		renderer.render(scene, camera);
		pass(tensorMaterial, tensorTarget);
		pass(blurX, blurTarget);
		pass(blurY, tensorTarget);
		pass(paintMaterial, null);
	};

	const dispose = () => {
		[colorTarget, tensorTarget, blurTarget].forEach(target => target.dispose());
		[tensorMaterial, blurX, blurY, paintMaterial].forEach(material => material.dispose());
		quad.geometry.dispose();
	};

	return { setSize, render, dispose };
};
