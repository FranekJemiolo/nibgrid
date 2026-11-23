#version 300 es
precision highp float;

layout(location = 0) in vec2 aRestUv;
layout(location = 1) in vec2 aDeformedPos;
layout(location = 2) in float aRotAngle;

uniform vec2 uFrameSize; // (outWidth, outHeight)
uniform float uPadPx;    // symmetric padding margin around rest sprite

out vec2 vUv;
out float vRotAngle;

void main() {
  vec2 px = aDeformedPos + vec2(uPadPx);
  vec2 ndc = (px / uFrameSize) * 2.0 - 1.0;
  ndc.y = -ndc.y; // Top-down pixel Y -> WebGL +Y up clip space
  vUv = vec2(aRestUv.x, 1.0 - aRestUv.y);
  vRotAngle = aRotAngle;
  gl_Position = vec4(ndc, 0.0, 1.0);
}

