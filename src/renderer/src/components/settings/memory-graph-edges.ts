import { EdgeProgram, createEdgeArrowHeadProgram, createEdgeCompoundProgram, type EdgeProgramType } from "sigma/rendering";
import { floatColor } from "sigma/utils";
import type { EdgeDisplayData, NodeDisplayData, RenderParams } from "sigma/types";
import type { ProgramInfo } from "sigma/rendering";

/**
 * Straight edges with a screen-space dash, plus the same arrow head the solid
 * edges use. Semantic and causal stay on Sigma's arrow program; temporal and
 * entity only differ by the dash period, which a uniform can express and a
 * second program class cannot share.
 *
 * Picking draws the whole segment: a gap must not make the edge unhittable.
 */

const UNIFORMS = [
  "u_matrix",
  "u_zoomRatio",
  "u_sizeRatio",
  "u_correctionRatio",
  "u_pixelRatio",
  "u_feather",
  "u_minEdgeThickness",
  "u_width",
  "u_height",
  "u_dash",
  "u_gap",
] as const;

type Uniform = (typeof UNIFORMS)[number];

const VERTEX_SHADER = /* glsl */ `
attribute vec4 a_id;
attribute vec4 a_color;
attribute vec2 a_normal;
attribute float a_normalCoef;
attribute vec2 a_positionStart;
attribute vec2 a_positionEnd;
attribute float a_positionCoef;

uniform mat3 u_matrix;
uniform float u_sizeRatio;
uniform float u_zoomRatio;
uniform float u_pixelRatio;
uniform float u_correctionRatio;
uniform float u_minEdgeThickness;
uniform float u_feather;
uniform float u_width;
uniform float u_height;

varying vec4 v_color;
varying vec2 v_normal;
varying float v_thickness;
varying float v_feather;
varying float v_along;

const float bias = 255.0 / 254.0;

void main() {
  float minThickness = u_minEdgeThickness;

  vec2 normal = a_normal * a_normalCoef;
  vec2 position = a_positionStart * (1.0 - a_positionCoef) + a_positionEnd * a_positionCoef;

  float normalLength = length(normal);
  vec2 unitNormal = normal / normalLength;

  float pixelsThickness = max(normalLength, minThickness * u_sizeRatio);
  float webGLThickness = pixelsThickness * u_correctionRatio / u_sizeRatio;

  gl_Position = vec4((u_matrix * vec3(position + unitNormal * webGLThickness, 1)).xy, 0, 1);

  vec2 clipStart = (u_matrix * vec3(a_positionStart, 1.0)).xy;
  vec2 clipEnd = (u_matrix * vec3(a_positionEnd, 1.0)).xy;
  vec2 pixels = (clipEnd - clipStart) * vec2(u_width, u_height) * 0.5;
  v_along = a_positionCoef * length(pixels);

  v_thickness = webGLThickness / u_zoomRatio;
  v_normal = unitNormal;
  v_feather = u_feather * u_correctionRatio / u_zoomRatio / u_pixelRatio * 2.0;

  #ifdef PICKING_MODE
  v_color = a_id;
  #else
  v_color = a_color;
  #endif

  v_color.a *= bias;
}
`;

const FRAGMENT_SHADER = /* glsl */ `
precision mediump float;

varying vec4 v_color;
varying vec2 v_normal;
varying float v_thickness;
varying float v_feather;
varying float v_along;

uniform float u_dash;
uniform float u_gap;

const vec4 transparent = vec4(0.0, 0.0, 0.0, 0.0);

void main(void) {
  #ifdef PICKING_MODE
  gl_FragColor = v_color;
  #else
  float period = u_dash + u_gap;
  if (period > 0.0 && mod(v_along, period) > u_dash) {
    gl_FragColor = transparent;
  } else {
    float dist = length(v_normal) * v_thickness;
    float t = smoothstep(v_thickness - v_feather, v_thickness, dist);
    gl_FragColor = mix(v_color, transparent, t);
  }
  #endif
}
`;

function createDashedEdgeProgram(dash: number, gap: number): EdgeProgramType {
  return class DashedEdgeProgram extends EdgeProgram<Uniform> {
    getDefinition(): ReturnType<EdgeProgram<Uniform>["getDefinition"]> {
      return {
        VERTICES: 6,
        VERTEX_SHADER_SOURCE: VERTEX_SHADER,
        FRAGMENT_SHADER_SOURCE: FRAGMENT_SHADER,
        METHOD: WebGLRenderingContext.TRIANGLES,
        UNIFORMS,
        ATTRIBUTES: [
          { name: "a_positionStart", size: 2, type: WebGLRenderingContext.FLOAT },
          { name: "a_positionEnd", size: 2, type: WebGLRenderingContext.FLOAT },
          { name: "a_normal", size: 2, type: WebGLRenderingContext.FLOAT },
          { name: "a_color", size: 4, type: WebGLRenderingContext.UNSIGNED_BYTE, normalized: true },
          { name: "a_id", size: 4, type: WebGLRenderingContext.UNSIGNED_BYTE, normalized: true },
        ],
        CONSTANT_ATTRIBUTES: [
          { name: "a_positionCoef", size: 1, type: WebGLRenderingContext.FLOAT },
          { name: "a_normalCoef", size: 1, type: WebGLRenderingContext.FLOAT },
        ],
        CONSTANT_DATA: [
          [0, 1],
          [0, -1],
          [1, 1],
          [1, 1],
          [0, -1],
          [1, -1],
        ],
      };
    }

    processVisibleItem(edgeIndex: number, startIndex: number, sourceData: NodeDisplayData, targetData: NodeDisplayData, data: EdgeDisplayData): void {
      const thickness = data.size || 1;
      const x1 = sourceData.x;
      const y1 = sourceData.y;
      const x2 = targetData.x;
      const y2 = targetData.y;
      const color = floatColor(data.color);
      const dx = x2 - x1;
      const dy = y2 - y1;
      let length = dx * dx + dy * dy;
      let n1 = 0;
      let n2 = 0;
      if (length) {
        length = 1 / Math.sqrt(length);
        n1 = -dy * length * thickness;
        n2 = dx * length * thickness;
      }
      const array = this.array;
      array[startIndex++] = x1;
      array[startIndex++] = y1;
      array[startIndex++] = x2;
      array[startIndex++] = y2;
      array[startIndex++] = n1;
      array[startIndex++] = n2;
      array[startIndex++] = color;
      array[startIndex++] = edgeIndex;
    }

    setUniforms(params: RenderParams, { gl, uniformLocations }: ProgramInfo<Uniform>): void {
      gl.uniformMatrix3fv(uniformLocations.u_matrix, false, params.matrix);
      gl.uniform1f(uniformLocations.u_zoomRatio, params.zoomRatio);
      gl.uniform1f(uniformLocations.u_sizeRatio, params.sizeRatio);
      gl.uniform1f(uniformLocations.u_correctionRatio, params.correctionRatio);
      gl.uniform1f(uniformLocations.u_pixelRatio, params.pixelRatio);
      gl.uniform1f(uniformLocations.u_feather, params.antiAliasingFeather);
      gl.uniform1f(uniformLocations.u_minEdgeThickness, params.minEdgeThickness);
      gl.uniform1f(uniformLocations.u_width, params.width);
      gl.uniform1f(uniformLocations.u_height, params.height);
      gl.uniform1f(uniformLocations.u_dash, dash);
      gl.uniform1f(uniformLocations.u_gap, gap);
    }
  };
}

/** Temporal relations: a dash about twice its gap. */
export const TemporalEdgeProgram: EdgeProgramType = createEdgeCompoundProgram([createDashedEdgeProgram(10, 6), createEdgeArrowHeadProgram()]);

/** Entity relations: a short dash, read as a dotted line at this thickness. */
export const EntityEdgeProgram: EdgeProgramType = createEdgeCompoundProgram([createDashedEdgeProgram(2, 4), createEdgeArrowHeadProgram()]);
