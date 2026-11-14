import * as THREE from "three";

/**
 * Illustrated look (after Kyprianidis & Döllner's image abstraction):
 *  1. a smoothed structure tensor gives every pixel an edge direction;
 *  2. a bilateral filter run across the edges, then along them, wipes out splat speckle while keeping edges;
 *  3. a difference of Gaussians across the edge, integrated along it, draws thin ink lines that follow the structure;
 *  4. a light grade and a static paper grain.
 * The canvas stays transparent (premultiplied output) so the page shows through.
 */

const header = /* glsl */ `
	precision highp float;
	in vec2 vUv;
	out vec4 outColor;
	uniform vec2 texel;
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

/** Edge tangent (unit) from a smoothed structure tensor; the gradient is its perpendicular. */
const tangentOf = /* glsl */ `
	vec2 tangentOf(vec3 g) {
		float root = sqrt(max((g.x - g.z) * (g.x - g.z) + 4.0 * g.y * g.y, 0.0));
		float lambda1 = 0.5 * (g.x + g.z + root);
		vec2 v = vec2(lambda1 - g.x, -g.y);
		return dot(v, v) > 1e-12 ? normalize(v) : vec2(0.0, 1.0);
	}
`;

/** Linear premultiplied scene to straight sRGB, the space the rest of the chain filters in. */
const prepShader = /* glsl */ `${header}
	uniform sampler2D tInput;
	vec3 toSrgb(vec3 c) {
		return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
	}
	void main() {
		vec4 c = texture(tInput, vUv);
		outColor = vec4(c.a > 0.0 ? toSrgb(clamp(c.rgb / c.a, 0.0, 1.0)) : vec3(0.0), c.a);
	}
`;

const tensorShader = /* glsl */ `${header}
	uniform sampler2D tInput;
	vec3 at(vec2 o) {
		vec4 c = texture(tInput, vUv + o * texel);
		return c.rgb * c.a;
	}
	void main() {
		vec3 gx = (at(vec2(1, 1)) + 2.0 * at(vec2(1, 0)) + at(vec2(1, -1)) - at(vec2(-1, 1)) - 2.0 * at(vec2(-1, 0)) - at(vec2(-1, -1))) * 0.25;
		vec3 gy = (at(vec2(-1, 1)) + 2.0 * at(vec2(0, 1)) + at(vec2(1, 1)) - at(vec2(-1, -1)) - 2.0 * at(vec2(0, -1)) - at(vec2(1, -1))) * 0.25;
		outColor = vec4(dot(gx, gx), dot(gx, gy), dot(gy, gy), 1.0);
	}
`;

const gaussShader = /* glsl */ `${header}
	uniform sampler2D tInput;
	uniform vec2 dir;
	void main() {
		const float sigma = 2.0;
		vec4 sum = vec4(0.0);
		float wsum = 0.0;
		for (int i = -6; i <= 6; i++) {
			float w = exp(-float(i * i) / (2.0 * sigma * sigma));
			sum += texture(tInput, vUv + dir * texel * float(i)) * w;
			wsum += w;
		}
		outColor = sum / wsum;
	}
`;

/** Bilateral filter along the gradient (across = 1) or along the edge (across = 0). */
const bilateralShader = /* glsl */ `${header}
	uniform sampler2D tInput;
	uniform sampler2D tTensor;
	uniform float across;
	uniform float sigmaD;
	uniform float sigmaR;
	${tangentOf}
	void main() {
		vec2 t = tangentOf(texture(tTensor, vUv).xyz);
		vec2 d = mix(t, vec2(t.y, -t.x), across) * texel;
		vec4 c0 = texture(tInput, vUv);
		vec3 sum = c0.rgb * c0.a;
		float wsum = c0.a;
		int r = int(ceil(2.0 * sigmaD));
		for (int i = 1; i <= 8; i++) {
			if (i > r) break;
			float ws = exp(-float(i * i) / (2.0 * sigmaD * sigmaD));
			for (int s = -1; s <= 1; s += 2) {
				vec4 c = texture(tInput, vUv + d * float(i * s));
				vec3 diff = c.rgb - c0.rgb;
				float w = ws * c.a * exp(-dot(diff, diff) / (2.0 * sigmaR * sigmaR));
				sum += c.rgb * w;
				wsum += w;
			}
		}
		outColor = vec4(wsum > 0.0 ? sum / wsum : c0.rgb, c0.a);
	}
`;

/** Difference of Gaussians of the luminance, sampled across the edge. */
const dogShader = /* glsl */ `${header}
	uniform sampler2D tInput;
	uniform sampler2D tTensor;
	uniform float sigmaE;
	uniform float tau;
	${tangentOf}
	float luma(vec4 c) { return dot(c.rgb, vec3(0.299, 0.587, 0.114)) * c.a + (1.0 - c.a); }
	void main() {
		vec2 t = tangentOf(texture(tTensor, vUv).xyz);
		vec2 n = vec2(t.y, -t.x) * texel;
		float sigmaK = 1.6 * sigmaE;
		vec2 sum = vec2(luma(texture(tInput, vUv)));
		vec2 wsum = vec2(1.0);
		for (int i = 1; i <= 6; i++) {
			float x = float(i);
			if (x > 2.0 * sigmaK) break;
			vec2 w = exp(-x * x / (2.0 * vec2(sigmaE * sigmaE, sigmaK * sigmaK)));
			float l = luma(texture(tInput, vUv + n * x)) + luma(texture(tInput, vUv - n * x));
			sum += l * w;
			wsum += 2.0 * w;
		}
		sum /= wsum;
		outColor = vec4(sum.x - tau * sum.y, 0.0, 0.0, 1.0);
	}
`;

const compositeShader = /* glsl */ `${header}
	uniform sampler2D tColor;
	uniform sampler2D tDog;
	uniform sampler2D tTensor;
	uniform float sigmaM;
	uniform float phi;
	uniform float ink;
	uniform float scale;
	${tangentOf}

	float hash(vec2 p) {
		return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
	}
	float noise(vec2 p) {
		vec2 i = floor(p), f = fract(p);
		f = f * f * (3.0 - 2.0 * f);
		return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
	}

	/** Integrate the DoG along the edge flow (line integral convolution) so lines come out long and unbroken. */
	float flowDog() {
		float sum = texture(tDog, vUv).r;
		float wsum = 1.0;
		for (int s = -1; s <= 1; s += 2) {
			vec2 p = vUv;
			vec2 prev = tangentOf(texture(tTensor, vUv).xyz) * float(s);
			for (int i = 1; i <= 8; i++) {
				float x = float(i);
				if (x > 2.0 * sigmaM) break;
				vec2 t = tangentOf(texture(tTensor, p).xyz);
				t = dot(t, prev) < 0.0 ? -t : t;
				prev = t;
				p += t * texel;
				float w = exp(-x * x / (2.0 * sigmaM * sigmaM));
				sum += texture(tDog, p).r * w;
				wsum += w;
			}
		}
		return sum / wsum;
	}

	void main() {
		vec4 c = texture(tColor, vUv);
		float alpha = c.a;
		vec3 col = c.rgb;

		// Ink: dark where the DoG dips below zero, fading softly
		float d = flowDog();
		float line = d < 0.0 ? 1.0 - (1.0 + tanh(phi * d)) : 0.0;
		line = clamp(line, 0.0, 1.0);

		// Grade: a touch more colour and a gentle lift in the shadows
		float luma = dot(col, vec3(0.299, 0.587, 0.114));
		col = clamp(mix(vec3(luma), col, 1.12), 0.0, 1.0);
		col = mix(col, vec3(1.0, 0.97, 0.92), 0.04);

		vec3 inkColor = col * vec3(0.32, 0.27, 0.24);
		col = mix(col, inkColor, line * ink);

		// Paper: fine tooth plus faint larger mottling, fixed to the screen
		vec2 px = vUv / texel / scale;
		float paper = (noise(px * 0.9) - 0.5) * 0.035 + (noise(px * 0.08) - 0.5) * 0.03;
		col += paper;

		outColor = vec4(clamp(col, 0.0, 1.0) * alpha, alpha);
	}
`;

export const createStylizePass = (renderer: THREE.WebGLRenderer) => {
	const sceneTarget = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: true });
	// three encodes to sRGB while rendering into the target, as it would for the canvas, and decodes on sampling
	sceneTarget.texture.colorSpace = THREE.SRGBColorSpace;
	const colorOptions = { depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter };
	const floatOptions = { ...colorOptions, type: THREE.HalfFloatType };
	const colorA = new THREE.WebGLRenderTarget(1, 1, colorOptions);
	const colorB = new THREE.WebGLRenderTarget(1, 1, colorOptions);
	const tensorA = new THREE.WebGLRenderTarget(1, 1, floatOptions);
	const tensorB = new THREE.WebGLRenderTarget(1, 1, floatOptions);
	const dogTarget = new THREE.WebGLRenderTarget(1, 1, floatOptions);
	const targets = [sceneTarget, colorA, colorB, tensorA, tensorB, dogTarget];

	const texel = { value: new THREE.Vector2() };
	const makeMaterial = (fragmentShader: string, uniforms: Record<string, THREE.IUniform> = {}) =>
		new THREE.RawShaderMaterial({
			glslVersion: THREE.GLSL3,
			uniforms: { texel, tInput: { value: null }, ...uniforms },
			vertexShader,
			fragmentShader,
			depthTest: false,
			depthWrite: false,
			blending: THREE.NoBlending
		});

	const prep = makeMaterial(prepShader);
	const tensor = makeMaterial(tensorShader);
	const gauss = makeMaterial(gaussShader, { dir: { value: new THREE.Vector2() } });
	const bilateral = makeMaterial(bilateralShader, {
		tTensor: { value: tensorA.texture },
		across: { value: 0 },
		sigmaD: { value: 3 },
		sigmaR: { value: 0.08 }
	});
	const dog = makeMaterial(dogShader, { tTensor: { value: tensorA.texture }, sigmaE: { value: 1 }, tau: { value: 0.99 } });
	const composite = makeMaterial(compositeShader, {
		tColor: { value: null },
		tDog: { value: dogTarget.texture },
		tTensor: { value: tensorA.texture },
		sigmaM: { value: 3 },
		phi: { value: 150 },
		ink: { value: 0.85 },
		scale: { value: 1 }
	});
	const materials = [prep, tensor, gauss, bilateral, dog, composite];

	const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
	const quadScene = new THREE.Scene().add(quad);
	const quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
	const pass = (material: THREE.RawShaderMaterial, input: THREE.Texture | null, target: THREE.WebGLRenderTarget | null) => {
		material.uniforms.tInput.value = input;
		quad.material = material;
		renderer.setRenderTarget(target);
		renderer.render(quadScene, quadCamera);
	};

	/** Size in drawing-buffer pixels; `scale` is the pixel ratio, so filter footprints hold steady in CSS pixels. */
	const setSize = (width: number, height: number, scale: number) => {
		targets.forEach(target => target.setSize(width, height));
		texel.value.set(1 / width, 1 / height);
		bilateral.uniforms.sigmaD.value = 2.5 * scale;
		dog.uniforms.sigmaE.value = 0.8 * scale;
		composite.uniforms.sigmaM.value = 2.5 * scale;
		composite.uniforms.scale.value = scale;
	};

	const render = (scene: THREE.Scene, camera: THREE.Camera) => {
		renderer.setRenderTarget(sceneTarget);
		renderer.clear();
		renderer.render(scene, camera);

		pass(prep, sceneTarget.texture, colorA);
		// The smoothed tensor ends up in tensorA, which every later pass reads
		pass(tensor, colorA.texture, tensorA);
		gauss.uniforms.dir.value.set(1, 0);
		pass(gauss, tensorA.texture, tensorB);
		gauss.uniforms.dir.value.set(0, 1);
		pass(gauss, tensorB.texture, tensorA);

		// Bilateral across the edges, then along them: A → B → A
		bilateral.uniforms.across.value = 1;
		pass(bilateral, colorA.texture, colorB);
		bilateral.uniforms.across.value = 0;
		pass(bilateral, colorB.texture, colorA);

		pass(dog, colorA.texture, dogTarget);
		composite.uniforms.tColor.value = colorA.texture;
		pass(composite, null, null);
	};

	const dispose = () => {
		targets.forEach(target => target.dispose());
		materials.forEach(material => material.dispose());
		quad.geometry.dispose();
	};

	return { setSize, render, dispose };
};

