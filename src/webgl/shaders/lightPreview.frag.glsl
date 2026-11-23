#version 300 es
precision highp float;

uniform sampler2D uDiffuse;
uniform sampler2D uNormal;
uniform sampler2D uBevel;

uniform vec3 uLightPos;
uniform vec3 uLightColor;
uniform float uLightIntensity;
uniform vec3 uAmbientColor;
uniform float uRoughness;
uniform float uInvertY;
uniform int uViewMode; // 0=Lit, 1=Normal, 2=Height, 3=Split
uniform float uSplitX;

in vec2 vUv;
out vec4 fragColor;

void main() {
  vec4 diff = texture(uDiffuse, vUv);
  if (diff.a < 0.01) discard;

  vec4 normSample = texture(uNormal, vUv);
  if (uViewMode == 1 || (uViewMode == 3 && vUv.x > uSplitX)) {
    fragColor = vec4(normSample.rgb, diff.a);
    return;
  }
  if (uViewMode == 2) {
    float h = texture(uBevel, vUv).r;
    fragColor = vec4(vec3(h), diff.a);
    return;
  }

  vec3 N = normalize(normSample.rgb * 2.0 - 1.0);
  N.y *= uInvertY;

  vec3 fragPos = vec3(vUv, 0.0);
  vec3 Lvec = uLightPos - fragPos;
  float dist = length(Lvec);
  vec3 L = Lvec / max(dist, 0.0001);

  float attenuation = 1.0 / (1.0 + 1.8 * dist * dist);
  float NdotL = max(dot(N, L), 0.0);
  vec3 diffuseTerm = diff.rgb * uLightColor * NdotL * uLightIntensity * attenuation;

  vec3 V = vec3(0.0, 0.0, 1.0);
  vec3 H = normalize(L + V);
  float shininess = mix(96.0, 6.0, uRoughness);
  float spec = pow(max(dot(N, H), 0.0), shininess) * (1.0 - uRoughness * 0.85);
  vec3 specTerm = uLightColor * spec * uLightIntensity * attenuation * 0.65;

  vec3 color = diff.rgb * uAmbientColor + diffuseTerm + specTerm;
  fragColor = vec4(clamp(color, 0.0, 1.0), diff.a);
}

