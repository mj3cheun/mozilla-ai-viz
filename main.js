import * as THREE from 'three';
import { getGPUTier } from 'detect-gpu';

import { GPUComputationRenderer } from 'three/addons/misc/GPUComputationRenderer.js';

/* TEXTURE WIDTH FOR SIMULATION */
const PARTICLE_MAX_WIDTH = 1024;

// Custom Geometry - using 3 triangles each. No UVs, no normals currently.
class ParticleGeometry extends THREE.InstancedBufferGeometry {

	constructor(width) {

		super();

		const trianglesPerParticle = 1;
		const triangles = width * width * trianglesPerParticle;
		const points = triangles * 3;

		const vertices = new THREE.BufferAttribute( new Float32Array( trianglesPerParticle * 3 * 3 ), 3 );
		const references = new THREE.InstancedBufferAttribute( new Float32Array( points * 2 ), 2 );
		const colors = new THREE.InstancedBufferAttribute( new Float32Array( points * 3 ), 3 );
		// const sizes = new THREE.BufferAttribute( new Float32Array( points * 1 ), 1);

		this.setAttribute( 'position', vertices );
		this.setAttribute( 'reference', references );
		this.setAttribute( 'color', colors );
		// this.setAttribute( 'size', sizes );
	
		// this.setAttribute( 'normal', new Float32Array( points * 3 ), 3 );

		let v = 0;

		function verts_push() {

			for ( let i = 0; i < arguments.length; i ++ ) {

				vertices.array[ v ++ ] = arguments[ i ];

			}

		}

		verts_push(
			...[
				0, -1, 0,
				0, 1, 0,
				0, 0, 1,
			]
		);

		const c = new THREE.Color('#555555');
		const MAX_POINTS = width * width;
		for ( let i = 0; i < MAX_POINTS * 3; i ++ ) {

			const triangleIndex = ~ ~ ( i / 3 );
			const pointIndex = ~ ~ ( triangleIndex );

			const xNormalized = ( pointIndex % width ) / width;
			const yNormalized = ~ ~ ( pointIndex / width ) / width;

			references.array[ i * 2 ] = xNormalized;
			references.array[ i * 2 + 1 ] = yNormalized;

			// const c = new THREE.Color(
			// 	0x666666 +
			// 	~ ~ ( i / 9 ) / MAX_POINTS * 0x666666
			// );

			colors.array[ i * 3 + 0 ] = c.r;
			colors.array[ i * 3 + 1 ] = c.g;
			colors.array[ i * 3 + 2 ] = c.b;

			// sizes.array[i * 1] = 20;

		}

		this.scale( ...(new Array(3).fill(0.3)) );

		// console.log('huhuhu');
		// console.log(vertices.array);
		// console.log(references.array);
		// console.log(colors.array);
		// console.log(sizes.array);

	}

}

//

let container, stats;
let camera, scene, renderer;
let mouseX = 0, mouseY = 0;

let windowHalfX = window.innerWidth / 2;
let windowHalfY = window.innerHeight / 2;

const BOUNDS = 800

const BOX_WIDTH = 200;

let particleTexWidth = 128;
let last = performance.now();
let forceAnimationActive = false;
let totalNumFrames = 0;

let gpuCompute;
let velocityVariable;
let positionVariable;
let positionUniforms;
let velocityUniforms;
let birdUniforms;

init();

async function init() {
	const gpuTier = getGPUTier();
	container = document.getElementById('animation-container');

	// set camera to look down on a vertex of the cube
	const cameraDistance = 150;
	camera = new THREE.PerspectiveCamera( 75, window.innerWidth / window.innerHeight, 1, 3000 );
	camera.translateX(cameraDistance);
	camera.translateY(cameraDistance);
	camera.translateZ(cameraDistance);
	camera.rotateY(Math.PI / 4);
	camera.rotateX(-Math.PI / 4.5);

	scene = new THREE.Scene();
	scene.background = new THREE.Color( 0x111111 );
	scene.fog = new THREE.Fog( 0xffffff, 100, 1000 );

	renderer = new THREE.WebGLRenderer({ powerPreference: "high-performance" });
	renderer.setPixelRatio( window.devicePixelRatio );
	renderer.setSize( window.innerWidth, window.innerHeight );
	container.style.opacity = 0;
	container.appendChild( renderer.domElement );

	// degrade number of particles based on detected GPU capabilities
	const targetFps = (await gpuTier).fps;

	// stats = new Stats();
	// container.appendChild( stats.dom );

	// container.style.touchAction = 'none';
	window.addEventListener( 'pointermove', onPointerMove );
	window.addEventListener( 'resize', onWindowResize );

	initComputeRenderer();
	initBirds(particleTexWidth);
	initBox();
	animate();

	let lastFPS;
	// keep incrementing count while fps within 20% of target fps
	do {
		scene.remove( scene.getObjectByName('birds') );
		initComputeRenderer();
		initBirds(particleTexWidth);

		lastFPS = await profileAnimation();
		particleTexWidth *= 2;
	} while((lastFPS > targetFps * 0.80) && (particleTexWidth <= PARTICLE_MAX_WIDTH));

	particleTexWidth /= 2;
	if(particleTexWidth !== PARTICLE_MAX_WIDTH) {
		scene.remove( scene.getObjectByName('birds') );
		initComputeRenderer();
		initBirds(particleTexWidth);
	}

	container.style.transition = 'opacity 1s';
	container.style.opacity = 1;
}

async function profileAnimation() {
	const PROFILE_TIME_IN_SECS = 0.2;

	forceAnimationActive = true;
	return new Promise((resolve) => {
		totalNumFrames = 0;
		setTimeout(() => {
			forceAnimationActive = false;
			resolve(totalNumFrames / PROFILE_TIME_IN_SECS);
		}, PROFILE_TIME_IN_SECS * 1000);
	})
}

function initComputeRenderer() {
	if( gpuCompute ) gpuCompute.dispose();
	gpuCompute = new GPUComputationRenderer( particleTexWidth, particleTexWidth, renderer );
	if ( renderer.capabilities.isWebGL2 === false ) {

		gpuCompute.setDataType( THREE.HalfFloatType );

	}

	const dtPosition = gpuCompute.createTexture();
	const dtVelocity = gpuCompute.createTexture();
	fillPositionTexture( dtPosition );
	fillVelocityTexture( dtVelocity );
	dtPosition.magFilter = THREE.NearestFilter;
	dtPosition.minFilter = THREE.NearestFilter;

	velocityVariable = gpuCompute.addVariable( 'textureVelocity', document.getElementById( 'fragmentShaderVelocity' ).textContent, dtVelocity );
	positionVariable = gpuCompute.addVariable( 'texturePosition', document.getElementById( 'fragmentShaderPosition' ).textContent, dtPosition );

	gpuCompute.setVariableDependencies( velocityVariable, [ positionVariable, velocityVariable ] );
	gpuCompute.setVariableDependencies( positionVariable, [ positionVariable, velocityVariable ] );

	positionUniforms = positionVariable.material.uniforms;
	velocityUniforms = velocityVariable.material.uniforms;

	positionUniforms[ 'time' ] = { value: 0.0 };
	positionUniforms[ 'delta' ] = { value: 0.0 };
	velocityUniforms[ 'time' ] = { value: 1.0 };
	velocityUniforms[ 'delta' ] = { value: 0.0 };
	velocityUniforms[ 'predator' ] = { value: new THREE.Vector3() };
	velocityUniforms[ "boxWidth" ] = { value: 200.0 };
	velocityVariable.material.defines.BOUNDS = BOUNDS.toFixed( 2 );

	velocityVariable.wrapS = THREE.RepeatWrapping;
	velocityVariable.wrapT = THREE.RepeatWrapping;
	positionVariable.wrapS = THREE.RepeatWrapping;
	positionVariable.wrapT = THREE.RepeatWrapping;

	const error = gpuCompute.init();

	if ( error !== null ) {

		console.error( error );

	}

}

function initBirds(numBirds = 128) {

	const geometry = new ParticleGeometry(numBirds);

	// For Vertex and Fragment
	birdUniforms = {
		'texturePosition': { value: null },
		'textureVelocity': { value: null },
		'time': { value: 1.0 },
		'delta': { value: 0.0 }
	};

	// THREE.ShaderMaterial
	const material = new THREE.ShaderMaterial( {
		uniforms: birdUniforms,
		vertexShader: document.getElementById( 'birdVS' ).textContent,
		fragmentShader: document.getElementById( 'birdFS' ).textContent,
		side: THREE.DoubleSide,
		blending: THREE.AdditiveBlending
	} );

	const birdMesh = new THREE.Mesh( geometry, material );
	birdMesh.rotation.y = Math.PI / 2;
	birdMesh.matrixAutoUpdate = false;
	birdMesh.updateMatrix();

	birdMesh.name = 'birds';
	scene.add( birdMesh );
}

function initBox() {
	const geometry = new THREE.BoxGeometry( BOX_WIDTH, BOX_WIDTH, BOX_WIDTH );
    const edgesGeometry = new THREE.EdgesGeometry( geometry );
    const material = new THREE.LineBasicMaterial({ opacity: 0.6, transparent: true });

	const edgeMesh = new THREE.LineSegments( edgesGeometry, material );
    scene.add( edgeMesh );
}

function partialRand() {
	return Math.random() < 0.3 ? Math.random() : 0.5;
}

function fillPositionTexture( texture ) {

	const theArray = texture.image.data;

	for ( let k = 0, kl = theArray.length; k < kl; k += 4 ) {

		const x = Math.random() * (BOX_WIDTH / 1) - (BOX_WIDTH / 2);
		const y = partialRand() * (BOX_WIDTH / 1) - (BOX_WIDTH / 2);
		const z = Math.random() * (BOX_WIDTH / 1) - (BOX_WIDTH / 2);

		theArray[ k + 0 ] = x;
		theArray[ k + 1 ] = y;
		theArray[ k + 2 ] = z;
		theArray[ k + 3 ] = 1;

	}

}

function fillVelocityTexture( texture ) {

	const theArray = texture.image.data;

	for ( let k = 0, kl = theArray.length; k < kl; k += 4 ) {

		const x = Math.random() - 0.5;
		const y = partialRand() - 0.5;
		const z = Math.random() - 0.5;

		theArray[ k + 0 ] = x * 10;
		theArray[ k + 1 ] = y * 10;
		theArray[ k + 2 ] = z * 10;
		theArray[ k + 3 ] = 0; // use as a point enabled switch

	}

}

function onWindowResize() {

	windowHalfX = window.innerWidth / 2;
	windowHalfY = window.innerHeight / 2;

	camera.aspect = window.innerWidth / window.innerHeight;
	camera.updateProjectionMatrix();

	renderer.setSize( window.innerWidth, window.innerHeight );

}

function onPointerMove( event ) {

	if ( event.isPrimary === false ) return;

	mouseX = event.clientX - windowHalfX;
	mouseY = event.clientY - windowHalfY;

}

//

function animate() {

	requestAnimationFrame( animate );

	render();
	// stats.update();

}

function render() {

	const now = performance.now();
	let delta = ( now - last ) / 1000;
	totalNumFrames++;

	const deltaCap = 0.5;
	if ( delta > deltaCap ) delta = deltaCap; // safety cap on large deltas
	last = now;

	// stop animation when tabbed out
	if (forceAnimationActive || document.hasFocus()) {
		positionUniforms[ 'time' ].value = now;
		positionUniforms[ 'delta' ].value = delta;
		velocityUniforms[ 'time' ].value = now;
		velocityUniforms[ 'delta' ].value = delta;
		birdUniforms[ 'time' ].value = now;
		birdUniforms[ 'delta' ].value = delta;
	
		velocityUniforms[ 'predator' ].value.set( 0.5 * mouseX / windowHalfX, - 0.5 * mouseY / windowHalfY, 0 );
	
		mouseX = 10000;
		mouseY = 10000;
	
		gpuCompute.compute();
	
		birdUniforms[ 'texturePosition' ].value = gpuCompute.getCurrentRenderTarget( positionVariable ).texture;
		birdUniforms[ 'textureVelocity' ].value = gpuCompute.getCurrentRenderTarget( velocityVariable ).texture;
	
		// birdUniforms[ 'texturePosition' ].value = window.dtPosition;
		// birdUniforms[ 'textureVelocity' ].value = window.dtVelocity;
	
		renderer.render( scene, camera );
	};
}
