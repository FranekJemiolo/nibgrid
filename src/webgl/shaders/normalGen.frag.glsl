#version 300 es
precision highp float;

uniform sampler2D uDiffuse;
uniform sampler2D uBevel;
uniform vec2 uTexelSize;
uniform float uBevelStrength;
uniform float uDetailStrength;
uniform float uInvertY; // +1.0 for OpenGL/Godot (+Y up), -1.0 for DirectX (-Y down)

in vec2 vUv;
out vec4 fragColor;

float sampleHeight(vec2 uv) {
  vec4 col = texture(uDiffuse, uv);
  float bevel = texture(uBevel, uv).r;
  float luma = dot(col.rgb, vec3(0.2126, 0.7152, 0.0722)) * col.a;
  return bevel * uBevelStrength + luma * uDetailStrength;
}

void main() {
  float centerAlpha = texture(uDiffuse, vUv).a;
  if (centerAlpha < 0.5) {
    fragColor = vec4(128.0 / 255.0, 128.0 / 255.0, 1.0, 0.0);
    return;
  }

  vec2 t = uTexelSize;
  float tl = sampleHeight(vUv + vec2(-t.x, t.y));
  float tc = sampleHeight(vUv + vec2(0.0, t.y));
  float tr = sampleHeight(vUv + vec2(t.x, t.y));
  float ml = sampleHeight(vUv + vec2(-t.x, 0.0));
  float mr = sampleHeight(vUv + vec2(t.x, 0.0));
  float bl = sampleHeight(vUv + vec2(-t.x, -t.y));
  float bc = sampleHeight(vUv + vec2(0.0, -t.y));
  float br = sampleHeight(vUv + vec2(t.x, -t.y));

  float dX = (tr + 2.0 * mr + br) - (tl + 2.0 * ml + bl);
  float dY = (tl + 2.0 * tc + tr) - (bl + 2.0 * bc + br);

  vec3 normal = normalize(vec3(-dX, -dY * uInvertY, 1.0));
  fragColor = vec4(normal * 0.5 + 0.5, centerAlpha);
}

