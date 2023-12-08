import * as THREE from 'three';

import { GPUComputationRenderer } from 'three/addons/misc/GPUComputationRenderer.js';

/* TEXTURE WIDTH FOR SIMULATION */
const WIDTH = 128;

const MAX_POINTS = WIDTH * WIDTH;

// Custom Geometry - using 3 triangles each. No UVs, no normals currently.
class ParticleGeometry extends THREE.BufferGeometry {

	constructor() {

		super();

		const trianglesPerParticle = 1;
		const triangles = MAX_POINTS * trianglesPerParticle;
		const points = triangles * 3;

		const vertices = new THREE.BufferAttribute( new Float32Array( points * 3 ), 3 );
		const references = new THREE.BufferAttribute( new Float32Array( points * 2 ), 2 );
		const colors = new THREE.BufferAttribute( new Float32Array( points * 3 ), 3 );
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

		for (let i = 0; i < MAX_POINTS; i++) {
			// equilateral triangle with sides of length 10 
			verts_push(
				...[
					0, -1, 0,
					0, 1, 0,
					0, 0, 10,
				].map(x => x)
			);
		}

		for ( let i = 0; i < MAX_POINTS * 3; i ++ ) {

			const triangleIndex = ~ ~ ( i / 3 );
			const pointIndex = ~ ~ ( triangleIndex );

			const xNormalized = ( pointIndex % WIDTH ) / WIDTH;
			const yNormalized = ~ ~ ( pointIndex / WIDTH ) / WIDTH;

			references.array[ i * 2 ] = xNormalized;
			references.array[ i * 2 + 1 ] = yNormalized;

			// const c = new THREE.Color(
			// 	0x666666 +
			// 	~ ~ ( i / 9 ) / MAX_POINTS * 0x666666
			// );
			const c = new THREE.Color('#666666');

			colors.array[ i * 3 + 0 ] = c.r;
			colors.array[ i * 3 + 1 ] = c.g;
			colors.array[ i * 3 + 2 ] = c.b;

			// sizes.array[i * 1] = 20;

		}

		this.scale( ...(new Array(3).fill(1)) );

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
const BOUNDS_HALF = BOUNDS / 2;

const BOX_WIDTH = 200;

let last = performance.now();

let gpuCompute;
let velocityVariable;
let positionVariable;
let positionUniforms;
let velocityUniforms;
let birdUniforms;

init();
animate();

function init() {

	container = document.createElement( 'div' );
	document.getElementById('animation-container').appendChild( container );

	// set camera to look down on a vertex of the cube
	const cameraDistance = 150;
	camera = new THREE.PerspectiveCamera( 75, window.innerWidth / window.innerHeight, 1, 3000 );
	camera.translateX(cameraDistance);
	camera.translateY(cameraDistance);
	camera.translateZ(cameraDistance);
	camera.rotateY(Math.PI / 4);
	camera.rotateX(-Math.PI / 4);

	scene = new THREE.Scene();
	scene.background = new THREE.Color( 0x111111 );
	scene.fog = new THREE.Fog( 0xffffff, 100, 1000 );

	renderer = new THREE.WebGLRenderer({ antialias: true });
	renderer.setPixelRatio( window.devicePixelRatio );
	renderer.setSize( window.innerWidth, window.innerHeight );
	container.appendChild( renderer.domElement );

	initComputeRenderer();

	// stats = new Stats();
	// container.appendChild( stats.dom );

	container.style.touchAction = 'none';
	container.addEventListener( 'pointermove', onPointerMove );

	//

	window.addEventListener( 'resize', onWindowResize );

	initBirds();
	// initBox();

}

function initComputeRenderer() {

	gpuCompute = new GPUComputationRenderer( WIDTH, WIDTH, renderer );

	if ( renderer.capabilities.isWebGL2 === false ) {

		gpuCompute.setDataType( THREE.HalfFloatType );

	}

	const dtPosition = gpuCompute.createTexture();
	const dtVelocity = gpuCompute.createTexture();
	fillPositionTexture( dtPosition );
	fillVelocityTexture( dtVelocity );
	dtPosition.magFilter = THREE.NearestFilter;
	dtPosition.minFilter = THREE.NearestFilter;
	//temp
	window.dtPosition = dtPosition;
	window.dtVelocity = dtVelocity;

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

function initBirds() {

	const geometry = new ParticleGeometry();

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

	scene.add( birdMesh );
}

function initBox() {
	const geometry = new THREE.BoxGeometry( BOX_WIDTH, BOX_WIDTH, BOX_WIDTH );
    const edgesGeometry = new THREE.EdgesGeometry( geometry );
    const material = new THREE.LineBasicMaterial();

	const edgeMesh = new THREE.LineSegments( edgesGeometry, material );
    scene.add( edgeMesh );
}

function fillPositionTexture( texture ) {

	const theArray = texture.image.data;

	for ( let k = 0, kl = theArray.length; k < kl; k += 4 ) {

		const x = Math.random() * (BOX_WIDTH / 1) - (BOX_WIDTH / 2);
		const y = Math.random() * (BOX_WIDTH / 1) - (BOX_WIDTH / 2);
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
		const y = Math.random() - 0.5;
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

	const deltaCap = 0.5;
	if ( delta > deltaCap ) delta = deltaCap; // safety cap on large deltas
	last = now;

	// stop animation when tabbed out
	if (document.hasFocus()) {
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
