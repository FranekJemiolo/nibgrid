#version 300 es
precision highp float;

uniform sampler2D uTexture;
uniform vec4 uTint;
uniform int uIsNormalMap;
uniform float uInvertY;

in vec2 vUv;
in float vRotAngle;
out vec4 fragColor;

void main() {
  vec4 tex = texture(uTexture, vUv);
  if (tex.a < 0.01) discard;

  if (uIsNormalMap == 1) {
    vec2 nxy = tex.rg * 2.0 - 1.0;
    float a = -vRotAngle * uInvertY;
    float c = cos(a);
    float s = sin(a);
    vec2 rot = vec2(c * nxy.x - s * nxy.y, s * nxy.x + c * nxy.y);
    fragColor = vec4(clamp(rot * 0.5 + 0.5, 0.0, 1.0), tex.b, tex.a);
    return;
  }

  fragColor = vec4(tex.rgb * uTint.rgb, tex.a * uTint.a);
}

