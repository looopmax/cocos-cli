// gl 模块 Electron ABI 冒烟测试：覆盖全部 patch 过的 GL 方法路径
const gl = require('./node_modules/gl');

console.log('gl loaded, typeof gl =', typeof gl);

const ctx = gl(256, 256, { preserveDrawingBuffer: true });
if (!ctx) {
	console.error('createContext FAILED');
	process.exit(1);
}
console.log('GL_VERSION:', ctx.getParameter(ctx.VERSION));

// 纹理上传（TypedArrayContents 路径）
const tex = ctx.createTexture();
ctx.bindTexture(ctx.TEXTURE_2D, tex);
const pixels = new Uint8Array(256 * 256 * 4);
ctx.texImage2D(ctx.TEXTURE_2D, 0, ctx.RGBA, 256, 256, 0, ctx.RGBA, ctx.UNSIGNED_BYTE, pixels);
ctx.texSubImage2D(ctx.TEXTURE_2D, 0, 0, 0, 256, 256, ctx.RGBA, ctx.UNSIGNED_BYTE, pixels);
console.log('texImage2D / texSubImage2D OK');

// 渲染
ctx.clearColor(0.2, 0.4, 0.8, 1.0);
ctx.clear(ctx.COLOR_BUFFER_BIT | ctx.DEPTH_BUFFER_BIT);
ctx.viewport(0, 0, 256, 256);
console.log('clear/viewport OK');

// readPixels（GetBufferSubData 类似路径）
const out = new Uint8Array(4);
ctx.readPixels(0, 0, 1, 1, ctx.RGBA, ctx.UNSIGNED_BYTE, out);
console.log('readPixels OK:', Array.from(out));

// buffer 上传/读取
const buf = ctx.createBuffer();
ctx.bindBuffer(ctx.ARRAY_BUFFER, buf);
const verts = new Float32Array([0, 0, 1, 0, 0, 1]);
ctx.bufferData(ctx.ARRAY_BUFFER, verts, ctx.STATIC_DRAW);
console.log('bufferData OK');

// Uniform / VertexAttrib 系列（patch 覆盖）
const vs = ctx.createShader(ctx.VERTEX_SHADER);
ctx.shaderSource(vs, 'attribute vec2 p; void main() { gl_Position = vec4(p, 0.0, 1.0); }');
ctx.compileShader(vs);
const fs = ctx.createShader(ctx.FRAGMENT_SHADER);
ctx.shaderSource(fs, 'precision mediump float; uniform vec4 u; void main() { gl_FragColor = u; }');
ctx.compileShader(fs);
const prog = ctx.createProgram();
ctx.attachShader(prog, vs);
ctx.attachShader(prog, fs);
ctx.linkProgram(prog);
ctx.useProgram(prog);

const loc = ctx.getUniformLocation(prog, 'u');
const uv = new Float32Array([1, 0, 0, 1]);
ctx.uniform4fv(loc, uv);
ctx.uniform1uiv(ctx.getUniformLocation(prog, 'nonexist'), new Uint32Array([1]));
ctx.uniform2uiv(ctx.getUniformLocation(prog, 'nonexist'), new Uint32Array([1, 2]));
ctx.uniform3uiv(ctx.getUniformLocation(prog, 'nonexist'), new Uint32Array([1, 2, 3]));
ctx.uniform4uiv(ctx.getUniformLocation(prog, 'nonexist'), new Uint32Array([1, 2, 3, 4]));
ctx.uniformMatrix4fv(ctx.getUniformLocation(prog, 'nonexist'), false, new Float32Array(16));
console.log('uniform* OK');

const attr = ctx.getAttribLocation(prog, 'p');
ctx.enableVertexAttribArray(attr);
ctx.vertexAttribPointer(attr, 2, ctx.FLOAT, false, 0, 0);
ctx.drawArrays(ctx.TRIANGLES, 0, 3);
console.log('drawArrays OK');

// 读取帧缓冲（preserveDrawingBuffer）
ctx.readPixels(0, 0, 1, 1, ctx.RGBA, ctx.UNSIGNED_BYTE, out);
console.log('final readPixels OK:', Array.from(out));

// 压力：循环渲染 100 次
for (let i = 0; i < 100; i++) {
	ctx.clear(ctx.COLOR_BUFFER_BIT);
	ctx.drawArrays(ctx.TRIANGLES, 0, 3);
}
console.log('stress loop OK');

console.log('stress loop OK');

console.log('ALL GL SMOKE TESTS PASSED');
process.exit(0);
