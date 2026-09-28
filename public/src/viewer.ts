import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import {
  DEFAULT_SOLID,
  SOLIDS,
  closestPointOnSegmentToRay,
  dist,
  distPointSegment,
  lineChordInHalfspaces,
  mul,
  projectToFace,
  trimmedSpan,
  v3,
  type Cut,
  type HalfSpace,
  type Line3,
  type Solid,
  type Vec3,
} from './geometry';
import { COLOR, cssColor } from './colors';
import { makeLabel, toV, type PickResult } from './objects3d';

const AXIS_LEN = 1.7;
// Плоскости пирамиды камеры. Нормали смотрят внутрь, поэтому точка p внутри,
// когда dot(n, p) + d >= 0, - ровно то же условие, что у HalfSpace.
const FRUSTUM_PLANES = 6;

export class Viewer {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  raycaster = new THREE.Raycaster();
  pointer = new THREE.Vector2();
  /** Фигура на сцене. Её ставит `setSolid`, остальное читает отсюда. */
  solid: Solid = SOLIDS[DEFAULT_SOLID];
  solidGroup = new THREE.Group();
  faceMeshes: THREE.Mesh[] = [];
  private gridGroup = new THREE.Group();
  objectsGroup = new THREE.Group();
  overlayGroup = new THREE.Group();
  private clipPlanes: THREE.Plane[] = [];
  private frustum = new THREE.Frustum();
  private viewMatrix = new THREE.Matrix4();
  private spaces: HalfSpace[] = Array.from({ length: FRUSTUM_PLANES }, () => ({
    n: v3(0, 0, 0),
    d: 0,
  }));
  private needsRender = true;
  private started = false;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.localClippingEnabled = true;
    this.renderer.setClearColor(0x202d3a, 1);

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    this.camera.position.set(3.2, 2.6, 3.6);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 1.6;
    this.controls.maxDistance = 16;
    // Левая кнопка отдана инструментам, поэтому вращение и сдвиг сцены ушли
    // на среднюю и правую и работают при любом выбранном инструменте.
    this.controls.mouseButtons = {
      LEFT: null,
      MIDDLE: THREE.MOUSE.ROTATE,
      RIGHT: THREE.MOUSE.PAN,
    };
    this.controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
    this.controls.addEventListener('change', () => (this.needsRender = true));

    this.scene.add(
      this.buildAxes(),
      this.solidGroup,
      this.objectsGroup,
      this.overlayGroup
    );
    this.setSolid(this.solid);
    this.resize();
  }

  /**
   * Часть прямой, попадающая в кадр. Ею же измеряется длина цилиндров прямых
   * и по ней же работает прилипание, поэтому рисунок и цель клика не могут
   * разойтись: обе берут один и тот же отрезок из пирамиды камеры.
   *
   * Обрезка идёт по пирамиде, а не по фигуре, поэтому прямая достаёт до края
   * экрана и не обрывается там, где до него ещё далеко.
   */
  lineExtent(l: Line3): [Vec3, Vec3] | null {
    this.updateFrustum();
    return lineChordInHalfspaces(l, this.spaces);
  }

  private updateFrustum(): void {
    this.camera.updateMatrixWorld();
    this.viewMatrix.multiplyMatrices(
      this.camera.projectionMatrix,
      this.camera.matrixWorldInverse
    );
    this.frustum.setFromProjectionMatrix(this.viewMatrix);
    for (let i = 0; i < FRUSTUM_PLANES; i++) {
      const pl = this.frustum.planes[i];
      this.spaces[i].n.x = pl.normal.x;
      this.spaces[i].n.y = pl.normal.y;
      this.spaces[i].n.z = pl.normal.z;
      this.spaces[i].d = pl.constant;
    }
  }

  /**
   * Подгоняет длины цилиндров прямых под текущий кадр.
   *
   * Цилиндры строятся единичной длины и растягиваются здесь, поэтому прямые
   * всегда дотягиваются до краёв экрана, а сцена не пересобирается на каждый
   * поворот камеры. Прямая за кадром скрывается целиком.
   *
   * Отрезок берётся из пирамиды камеры, но у отсечённой прямой он обрезан ещё
   * и по `trim`. Обрезка рисуется и притягивает по одному и тому же отрезку, и
   * для неё это отдельная функция, а не хорда кадра: иначе отрезанный хвост
   * вернулся бы на экран.
   */
  private fitLines(): void {
    for (const obj of this.objectsGroup.children) {
      const line = obj.userData.lineRef as Line3 | null | undefined;
      const mesh = obj.userData.lineMesh as THREE.Mesh | undefined;
      if (!line || !mesh) continue;
      const cut = obj.userData.lineCut as Cut | null | undefined;
      const base = this.lineExtent(line);
      if (!base) {
        obj.visible = false;
        continue;
      }
      obj.visible = true;
      const [a, b] = trimmedSpan(this.solid, base, cut ?? undefined);
      mesh.position.set((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
      mesh.scale.set(1, dist(a, b), 1);
    }
  }

  requestRender(): void {
    this.needsRender = true;
  }

  /**
   * Плоскости граней фигуры: по ним плоскость сечения обрезается по фигуре.
   *
   * `THREE.Plane` держит ту сторону, где `dot(n, p) + constant >= 0`, поэтому
   * наружу смотрящая нормаль грани входит с минусом: полупространство должно
   * остаться внутри фигуры, а не снаружи.
   */
  get clip(): THREE.Plane[] {
    if (!this.clipPlanes.length) {
      this.clipPlanes = this.solid.faces.map(
        (f) => new THREE.Plane(toV(mul(f.normal, -1)), f.d)
      );
    }
    return this.clipPlanes;
  }

  private buildAxes(): THREE.Group {
    const g = new THREE.Group();
    const defs: { dir: Vec3; color: number; label: string }[] = [
      { dir: v3(1, 0, 0), color: 0xff5c6c, label: 'X' },
      { dir: v3(0, 1, 0), color: 0x7bd88f, label: 'Y' },
      { dir: v3(0, 0, 1), color: 0x5aa9ff, label: 'Z' },
    ];
    for (const def of defs) {
      const from = new THREE.Vector3(
        def.dir.x * -AXIS_LEN,
        def.dir.y * -AXIS_LEN,
        def.dir.z * -AXIS_LEN
      );
      const to = new THREE.Vector3(def.dir.x * AXIS_LEN, def.dir.y * AXIS_LEN, def.dir.z * AXIS_LEN);
      g.add(
        new THREE.Line(
          new THREE.BufferGeometry().setFromPoints([from, to]),
          new THREE.LineBasicMaterial({ color: def.color, transparent: true, opacity: 0.85 })
        )
      );
      const head = new THREE.Mesh(
        new THREE.ConeGeometry(0.045, 0.16, 16),
        new THREE.MeshBasicMaterial({ color: def.color })
      );
      const dir = toV(def.dir);
      head.position.copy(to.clone().sub(dir.clone().multiplyScalar(0.05)));
      head.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
      g.add(head);

      const label = makeLabel(def.label, cssColor(def.color), 0.18, false);
      label.position.copy(to.clone().add(dir.clone().multiplyScalar(0.14)));
      g.add(label);
    }
    const origin = makeLabel('O', '#dbe4ec', 0.13, false);
    origin.position.set(0, 0, 0);
    g.add(origin);
    return g;
  }

  /**
   * Сетка лежит под фигурой, а не под кубом: у параллелепипеда своя высота, и
   * сетка на месте `y = −1` оказалась бы внутри него.
   */
  private buildGrid(): THREE.Group {
    const grid = new THREE.GridHelper(4, 20, 0x4a6076, 0x33465a);
    grid.position.y = this.floorY() - 0.001;
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.5;
    return new THREE.Group().add(grid);
  }

  /** Нижняя точка фигуры: на ней стоит сетка. */
  private floorY(): number {
    return Math.min(...this.solid.vertices.map((v) => v.y));
  }

  private highlightIndex: number | null = null;

  /**
   * Постановка фигуры на сцену. Всё, что зависит от неё, строится здесь и
   * только здесь: каркас, полупрозрачные грани, клип-плоскости листа и сетка.
   * Отдельные копии этих списков в других местах разошлись бы с фигурой при
   * первой же смене.
   */
  setSolid(solid: Solid): void {
    if (this.solid === solid && this.solidGroup.children.length) return;
    this.solid = solid;
    this.scene.remove(this.solidGroup);
    disposeTree(this.solidGroup);
    this.solidGroup = new THREE.Group();
    this.scene.add(this.solidGroup);
    this.clipPlanes = [];
    this.faceMeshes = [];
    this.highlightIndex = null;
    this.buildSolid();
    this.setGrid();
    this.needsRender = true;
  }

  private setGrid(): void {
    this.scene.remove(this.gridGroup);
    disposeTree(this.gridGroup);
    this.gridGroup = this.buildGrid();
    this.scene.add(this.gridGroup);
  }

  /**
   * Каркас и грани фигуры. Грань рисуется веером треугольников от первой
   * вершины: у куба это два треугольника, у тетраэдра один, и тот же код
   * покрывает оба случая.
   */
  private buildSolid(): void {
    const pts: number[] = [];
    for (const [i, j] of this.solid.edges) {
      const a = this.solid.vertices[i];
      const b = this.solid.vertices[j];
      pts.push(a.x, a.y, a.z, b.x, b.y, b.z);
    }
    const edgeGeo = new THREE.BufferGeometry();
    edgeGeo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    this.solidGroup.add(
      new THREE.LineSegments(
        edgeGeo,
        new THREE.LineBasicMaterial({ color: 0xcfdae4, transparent: true, opacity: 0.9 })
      )
    );

    this.solid.faces.forEach((face, i) => {
      const positions: number[] = [];
      for (const idx of face.poly) {
        const p = this.solid.vertices[idx];
        positions.push(p.x, p.y, p.z);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      const idx: number[] = [];
      for (let k = 1; k + 1 < face.poly.length; k++) idx.push(0, k, k + 1);
      geo.setIndex(idx);
      const mesh = new THREE.Mesh(
        geo,
        new THREE.MeshBasicMaterial({
          color: 0x35485c,
          transparent: true,
          opacity: 0.12,
          side: THREE.DoubleSide,
          depthWrite: false,
        })
      );
      mesh.userData.faceIndex = i;
      mesh.renderOrder = 1;
      this.faceMeshes.push(mesh);
      this.solidGroup.add(mesh);
    });
  }

  setObjectGroup(group: THREE.Group): void {
    this.scene.remove(this.objectsGroup);
    disposeTree(this.objectsGroup);
    this.objectsGroup = group;
    this.scene.add(this.objectsGroup);
    this.fitLines();
    this.needsRender = true;
  }

  setOverlay(group: THREE.Group): void {
    this.scene.remove(this.overlayGroup);
    disposeTree(this.overlayGroup);
    this.overlayGroup = group;
    this.scene.add(this.overlayGroup);
    this.needsRender = true;
  }

  setFaceHighlight(index: number | null): void {
    if (index === -1) index = null;
    if (this.highlightIndex === index) return;
    if (this.highlightIndex !== null) {
      const prev = this.faceMeshes[this.highlightIndex];
      (prev.material as THREE.MeshBasicMaterial).color.setHex(0x35485c);
      (prev.material as THREE.MeshBasicMaterial).opacity = 0.12;
    }
    this.highlightIndex = index;
    if (index !== null) {
      const mat = this.faceMeshes[index].material as THREE.MeshBasicMaterial;
      mat.color.setHex(0x3f7fd0);
      mat.opacity = 0.3;
    }
    this.needsRender = true;
  }

  /**
   * Грань, на которую попадёт точка.
   *
   * Луч указателя пересекает сразу несколько граней, в том числе дальние на
   * противоположной стороне фигуры: все они проецируются в один и тот же пиксель,
   * поэтому расстояние на экране их не различает. Главный признак - глубина
   * вдоль луча, то есть ближайшая к камере грань и есть та, на которую смотрят,
   * а `faceDepth` только развязывает ничьи: он растёт в центре грани, и рядом
   * с центром фигуры одного признака было бы мало, выбор выродился бы в
   * случайность.
   *
   * Сначала берётся грань, в которую луч попал по-настоящему, и лишь потом та,
   * мимо которой он прошёл рядом. Иначе грань, чью плоскость луч пересекает
   * раньше, но чей многоугольник он не задел, обгоняла бы ту, что под курсором:
   * её пересечение с плоскостью просто дальше от камеры, чем вход в фигуру.
   */
  pickFaceSurface(stickWorld = 0): PickResult {
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const ray = this.raycaster.ray;
    const maxStick = stickWorld > 0 ? stickWorld : 0.02;
    type Candidate = { point: Vec3; faceIndex: number; depth: number; insideness: number };
    const closer = (a: Candidate, b: Candidate): boolean =>
      a.depth < b.depth - 1e-4 ||
      (Math.abs(a.depth - b.depth) <= 1e-4 && a.insideness > b.insideness);

    let hit: Candidate | null = null;
    let near: Candidate | null = null;

    for (let f = 0; f < this.solid.faces.length; f++) {
      const face = this.solid.faces[f];
      const plane = new THREE.Plane(toV(face.normal), -face.d);
      const pt = new THREE.Vector3();
      if (!ray.intersectPlane(plane, pt)) continue;
      if (pt.distanceTo(ray.origin) > 40) continue;

      const raw = v3(pt.x, pt.y, pt.z);
      const projected = projectToFace(this.solid, raw, f);
      // Насколько попадание вылезло за многоугольник грани: ноль, когда луч лёг
      // ровно на грань, и положительное число, когда курсор уже за её краем.
      const overshoot = dist(raw, projected);
      if (overshoot > maxStick) continue;

      const cand: Candidate = {
        point: projected,
        faceIndex: f,
        depth: pt.distanceTo(ray.origin),
        insideness: this.faceDepth(projected, f),
      };
      if (overshoot <= 1e-6) {
        if (!hit || closer(cand, hit)) hit = cand;
      } else if (!near || closer(cand, near)) {
        near = cand;
      }
    }

    const best = hit ?? near;
    if (!best) return { type: 'none' };
    return { type: 'face', point: best.point, faceIndex: best.faceIndex };
  }

  /**
   * Насколько точка глубоко внутри своей грани: расстояние до ближайшего края.
   *
   * У куба это были поля до четырёх сторон квада, у произвольной грани сторон
   * сколько угодно и они стоят под углом, поэтому берётся минимум по рёбрам
   * многоугольника. Отрицательным числом точка за краем не бывает: грань
   * прижата к себе функцией `projectToFace`.
   */
  faceDepth(p: Vec3, faceIndex: number): number {
    const face = this.solid.faces[faceIndex];
    let best = Infinity;
    for (let i = 0; i < face.poly.length; i++) {
      const a = this.solid.vertices[face.poly[i]];
      const b = this.solid.vertices[face.poly[(i + 1) % face.poly.length]];
      const d = distPointSegment(p, a, b);
      if (d < best) best = d;
    }
    return best;
  }

  setNdc(event: PointerEvent, canvas: HTMLCanvasElement): void {
    const rect = canvas.getBoundingClientRect();
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  }

  /**
   * Полупрозрачный шар - точка, которая встанет по клику. Рисуется без
   * проверки глубины, иначе внутри фигуры её не было бы видно.
   *
   * Кольцо живёт в плоскости XY, поэтому его надо развернуть по нормали грани.
   * При `faceIndex === null` опорной грани нет вовсе: у точки на прямой за
   * пределами фигуры её не существует, и кольцо разворачивается в камеру,
   * иначе торец уезжает на ребро и превью пропадает.
   */
  setPreview(point: Vec3 | null, faceIndex: number | null, kind: 'point' | 'line' = 'point'): void {
    this.clearPreview();
    if (!point) return;
    const color = kind === 'point' ? COLOR.point : COLOR.line;
    const ghost = new THREE.Mesh(
      new THREE.SphereGeometry(0.055, 20, 14),
      new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.45,
        depthTest: false,
      })
    );
    ghost.position.set(point.x, point.y, point.z);
    ghost.renderOrder = 20;
    ghost.userData.isPreview = true;

    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(0.1, 0.007, 8, 32),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.75, depthTest: false })
    );
    ring.position.set(point.x, point.y, point.z);
    ring.renderOrder = 21;
    ring.userData.isPreview = true;
    if (faceIndex !== null) {
      ring.quaternion.setFromUnitVectors(
        new THREE.Vector3(0, 0, 1),
        toV(this.solid.faces[faceIndex].normal)
      );
    } else {
      ring.quaternion.copy(this.camera.quaternion);
    }
    this.overlayGroup.add(ghost, ring);
  }

  clearPreview(): void {
    for (let i = this.overlayGroup.children.length - 1; i >= 0; i--) {
      const child = this.overlayGroup.children[i];
      if (child.userData.isPreview) {
        this.overlayGroup.remove(child);
        (child as THREE.Mesh).geometry.dispose();
        ((child as THREE.Mesh).material as THREE.Material).dispose();
      }
    }
  }

  pickObject(): { id: string; kind: string; part: string } | null {
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const targets: THREE.Object3D[] = [];
    this.objectsGroup.traverse((o) => {
      const ud = o.userData as { objId?: string; pickable?: boolean };
      // Прямая, ушедшая за кадр, скрывается, но `Raycaster` видимость не
      // проверяет, и без этой проверки она цеплялась бы курсором там, где её
      // уже нет.
      if (o.visible && ud.pickable && ud.objId) targets.push(o);
    });
    const hits = this.raycaster.intersectObjects(targets, false);
    for (const h of hits) {
      const ud = h.object.userData as { objId?: string; part?: string; objKind?: string };
      if (ud.objId) return { id: ud.objId, kind: ud.objKind ?? '', part: ud.part ?? '' };
    }
    return null;
  }

  /**
   * Луч указателя в плоскости, параллельной экрану и проходящей через `p`.
   *
   * Так двигается угол фигуры: у него нет опорной грани, иначе тянуть пришлось бы
   * по одной оси за раз, а свободное движение в плоскости экрана - единственное,
   * что человек видит с одного взгляда. Плоскость берётся через саму точку
   * угла, иначе угол уезжал бы вглубь по ходу луча, и при повороте сцены
   * двигался бы совсем не туда.
   */
  rayThroughScreen(p: Vec3): Vec3 | null {
    const dir = new THREE.Vector3();
    this.camera.getWorldDirection(dir);
    return this.rayToPlane(dir, -dir.dot(toV(p)));
  }

  rayToPlane(n: THREE.Vector3, d: number): Vec3 | null {
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const plane = new THREE.Plane(n, d);
    const pt = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(plane, pt)) return null;
    return v3(pt.x, pt.y, pt.z);
  }

  rayToPointDistance(x: number, y: number, z: number): number {
    this.raycaster.setFromCamera(this.pointer, this.camera);
    return this.raycaster.ray.distanceToPoint(new THREE.Vector3(x, y, z));
  }

  /**
   * Ближайшая точка отрезка прямой к лучу указателя вместе с расстоянием.
   * Считается точно, поэтому прилипание доступно в любом месте прямой, а не
   * только в дискретных отсчётах.
   */
  rayToSegmentHit(a: Vec3, b: Vec3): { p: Vec3; d: number } {
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const ray = this.raycaster.ray;
    return closestPointOnSegmentToRay(
      v3(ray.origin.x, ray.origin.y, ray.origin.z),
      v3(ray.direction.x, ray.direction.y, ray.direction.z),
      a,
      b
    );
  }

  /**
   * Ставит камеру так, чтобы фигура целиком попала в кадр.
   *
   * Угол наклона и расстояние считаются от габарита фигуры, а не заданы
   * константой: у тетраэдра вдвое меньше куба по высоте, и вид с кубического
   * расстояния оставлял бы его мелким и смещённым.
   */
  fit(): void {
    const { center, radius } = this.bounds();
    const dir = new THREE.Vector3(3.2, 2.6, 3.6).normalize();
    this.camera.position.copy(toV(center)).addScaledVector(dir, radius * 3.2);
    this.controls.target.copy(toV(center));
    this.controls.update();
    this.needsRender = true;
  }

  /** Центр описанной сферы фигуры и её радиус: им меряется кадр. */
  private bounds(): { center: Vec3; radius: number } {
    const acc = this.solid.vertices.reduce(
      (m, v) => ({
        min: v3(Math.min(m.min.x, v.x), Math.min(m.min.y, v.y), Math.min(m.min.z, v.z)),
        max: v3(Math.max(m.max.x, v.x), Math.max(m.max.y, v.y), Math.max(m.max.z, v.z)),
      }),
      { min: v3(Infinity, Infinity, Infinity), max: v3(-Infinity, -Infinity, -Infinity) }
    );
    const center = v3(
      (acc.min.x + acc.max.x) / 2,
      (acc.min.y + acc.max.y) / 2,
      (acc.min.z + acc.max.z) / 2
    );
    return { center, radius: Math.max(...this.solid.vertices.map((v) => dist(v, center))) };
  }

  resize(): void {
    const canvas = this.renderer.domElement;
    const w = canvas.clientWidth || 1;
    const h = canvas.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.needsRender = true;
  }

  start(): void {
    if (this.started) {
      this.needsRender = true;
      return;
    }
    this.started = true;
    const loop = () => {
      this.controls.update();
      if (this.needsRender) {
        // Прямые тянутся до краёв кадра, поэтому их длина пересчитывается
        // перед отрисовкой: поворот камеры меняет видимую часть прямой.
        this.fitLines();
        this.renderer.render(this.scene, this.camera);
        this.needsRender = false;
      }
      requestAnimationFrame(loop);
    };
    loop();
  }
}

export function disposeTree(root: THREE.Object3D): void {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    mesh.geometry?.dispose();
    const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
    else if (mat) {
      (mat as THREE.SpriteMaterial).map?.dispose();
      mat.dispose();
    }
  });
}
