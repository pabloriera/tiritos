use std::{
    collections::HashMap,
    env, fs,
    path::{Path as FilePath, PathBuf},
    sync::{Arc, Mutex},
    time::{Instant, SystemTime, UNIX_EPOCH},
};

use axum::{
    Json, Router,
    extract::ws::{Message, WebSocket, WebSocketUpgrade},
    extract::{Path, State},
    http::{StatusCode, header},
    response::{Html, IntoResponse, Response},
    routing::{get, post},
};
use base64::{Engine, engine::general_purpose::STANDARD as BASE64};
use paint_arena_server::maps::{
    decoder::decode_and_validate_png,
    palette::{FLOOR, METRO, Rgb, WALL},
    validator::ValidatedMap,
};
use rand::Rng;
use serde::{Deserialize, Serialize};
use tokio::{
    sync::watch,
    time::{Duration, interval},
};
use tower_http::services::{ServeDir, ServeFile};

const TICK_RATE_HZ: u64 = 30;
const TICK_SECONDS: f32 = 1.0 / TICK_RATE_HZ as f32;
const PLAYER_RADIUS: f32 = 10.0;
const MAX_SPEED: f32 = 165.0;
const ACCELERATION: f32 = 300.0;
const BRAKING: f32 = 360.0;
const FRICTION: f32 = 150.0;
const TURN_SPEED: f32 = 3.4;
const FIRE_COOLDOWN_SECONDS: f32 = 0.14;
const BULLET_RADIUS: f32 = 3.0;
const BULLET_SPEED: f32 = 440.0;
const BULLET_DAMAGE: u16 = 34;
const GRENADE_SPEED: f32 = 285.0;
const GRENADE_LIFETIME_SECONDS: f32 = 1.15;
const GRENADE_COOLDOWN_SECONDS: f32 = 2.0;
const GRENADE_BLAST_RADIUS: f32 = 72.0;
const BULLET_CRATER_RADIUS: f32 = 5.0;
const GRENADE_CRATER_RADIUS: f32 = 46.0;
const BLAST_VISIBLE_TICKS: u64 = TICK_RATE_HZ / 2;
const WALL_FIELD_RADIUS: f32 = 38.0;
const COUNTDOWN_TICKS: u64 = TICK_RATE_HZ * 3;
const RESPAWN_TICKS: u64 = TICK_RATE_HZ * 2;
const SPAWN_PROTECTION_TICKS: u64 = TICK_RATE_HZ;
const METRO_COOLDOWN_SECONDS: f32 = 1.5;
const ROOM_EXPIRY_MILLIS: u128 = 60 * 60 * 1000;
const MIN_CUSTOM_MAP_WIDTH: u16 = 320;
const MIN_CUSTOM_MAP_HEIGHT: u16 = 180;
const MAX_CUSTOM_MAP_WIDTH: u16 = 2048;
const MAX_CUSTOM_MAP_HEIGHT: u16 = 2048;
const MAX_CUSTOM_PLAYERS: usize = 8;
const MAX_CUSTOM_METROS: usize = 16;

#[derive(Clone)]
struct GameMap {
    id: String,
    name: String,
    image_url: String,
    image_bytes: Arc<Vec<u8>>,
    compiled: Arc<ValidatedMap>,
    manifest: Arc<MapManifest>,
}

impl GameMap {
    fn spawn_for(&self, slot: u8, deaths: u16) -> (f32, f32) {
        let player = self
            .manifest
            .players
            .iter()
            .find(|player| player.slot == slot)
            .or_else(|| self.manifest.players.first());
        let Some(player) = player else {
            return (
                f32::from(self.compiled.width) / 2.0,
                f32::from(self.compiled.height) / 2.0,
            );
        };
        let Some(location) = player
            .spawn_locations
            .get(usize::from(deaths) % player.spawn_locations.len().max(1))
        else {
            return (
                f32::from(self.compiled.width) / 2.0,
                f32::from(self.compiled.height) / 2.0,
            );
        };
        (location.x, location.y)
    }

    fn player_color(&self, slot: u8) -> &str {
        self.manifest
            .players
            .iter()
            .find(|player| player.slot == slot)
            .map(|player| player.color.as_str())
            .unwrap_or("#FFFFFF")
    }

    fn metro_destination(&self, x: f32, y: f32, radius: f32) -> Option<(f32, f32)> {
        let stations = &self.manifest.metro_stations;
        if stations.len() < 2 {
            return None;
        }
        let source = stations.iter().position(|station| {
            distance_squared(station.location.x, station.location.y, x, y)
                <= (radius + 18.0).powi(2)
        })?;
        let destination = &stations[(source + 1) % stations.len()].location;
        Some((destination.x, destination.y))
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MapManifest {
    number_of_players: u8,
    players: Vec<MapPlayerDefinition>,
    metro_stations: Vec<MetroStationDefinition>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MapPlayerDefinition {
    slot: u8,
    color: String,
    spawn_locations: Vec<MapLocation>,
}

#[derive(Debug, Deserialize)]
struct MetroStationDefinition {
    #[serde(rename = "id")]
    _id: String,
    #[serde(rename = "color")]
    _color: String,
    location: MapLocation,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
struct MapLocation {
    x: f32,
    y: f32,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct CustomMapRequest {
    name: String,
    width: u16,
    height: u16,
    wall_mask: String,
    players: Vec<CustomPlayerDefinition>,
    metro_stations: Vec<MapLocation>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct CustomPlayerDefinition {
    color: String,
    location: MapLocation,
}

#[derive(Debug, Deserialize, Serialize)]
struct SavedCustomMap {
    id: String,
    map: CustomMapRequest,
}

#[derive(Clone)]
struct AppState {
    rooms: Arc<Mutex<HashMap<String, Room>>>,
    metrics: Arc<Mutex<ServerMetrics>>,
    maps: Arc<Mutex<HashMap<String, GameMap>>>,
    room_streams: Arc<Mutex<HashMap<String, watch::Sender<String>>>>,
    custom_map_dir: Arc<PathBuf>,
}

impl AppState {
    fn new() -> Self {
        let custom_map_dir =
            PathBuf::from(env::var("CUSTOM_MAP_DIR").unwrap_or_else(|_| "maps/custom".to_owned()));
        let mut maps = load_builtin_maps();
        load_saved_custom_maps(&custom_map_dir, &mut maps);
        Self {
            rooms: Arc::new(Mutex::new(HashMap::new())),
            metrics: Arc::new(Mutex::new(ServerMetrics::default())),
            maps: Arc::new(Mutex::new(maps)),
            room_streams: Arc::new(Mutex::new(HashMap::new())),
            custom_map_dir: Arc::new(custom_map_dir),
        }
    }
}

#[derive(Debug, Clone)]
struct ServerMetrics {
    started_at: Instant,
    room_gets: u64,
    input_posts: u64,
    created_rooms: u64,
    joins: u64,
    ticks: u64,
    last_tick_ms: f32,
    max_tick_ms: f32,
    websocket_connections: u64,
}

impl Default for ServerMetrics {
    fn default() -> Self {
        Self {
            started_at: Instant::now(),
            room_gets: 0,
            input_posts: 0,
            created_rooms: 0,
            joins: 0,
            ticks: 0,
            last_tick_ms: 0.0,
            max_tick_ms: 0.0,
            websocket_connections: 0,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MapSummary {
    id: String,
    name: String,
    image_url: String,
    width: u16,
    height: u16,
    number_of_players: u8,
    preview_spawn_x: f32,
    preview_spawn_y: f32,
    preview_player_color: String,
    metro_stations: Vec<MapLocation>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Room {
    id: String,
    map_id: String,
    death_limit: u16,
    player_limit: u8,
    phase: RoomPhase,
    phase_ends_at_tick: Option<u64>,
    winner_slot: Option<u8>,
    tick: u64,
    players: Vec<PlayerSummary>,
    bullets: Vec<BulletSummary>,
    wall_craters: Vec<WallCrater>,
    #[serde(skip_serializing)]
    wall_pixels: Vec<bool>,
    blasts: Vec<BlastSummary>,
    feed: Vec<String>,
    #[serde(skip_serializing)]
    next_bullet_id: u64,
    #[serde(skip_serializing)]
    next_blast_id: u64,
    #[serde(skip_serializing)]
    last_activity_millis: u128,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum RoomPhase {
    Lobby,
    Countdown,
    Playing,
    Ended,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum PlayerState {
    Alive,
    Respawning,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PlayerSummary {
    id: String,
    nickname: String,
    slot: u8,
    color: String,
    kills: u16,
    deaths: u16,
    host: bool,
    x: f32,
    y: f32,
    heading: f32,
    speed: f32,
    health: u16,
    state: PlayerState,
    respawn_at_tick: Option<u64>,
    invulnerable_until_tick: u64,
    #[serde(skip_serializing)]
    session_token: String,
    #[serde(skip_serializing)]
    input: ControlInput,
    #[serde(skip_serializing)]
    last_input_sequence: u64,
    #[serde(skip_serializing)]
    fire_cooldown: f32,
    #[serde(skip_serializing)]
    metro_cooldown: f32,
    #[serde(skip_serializing)]
    grenade_cooldown: f32,
    #[serde(skip_serializing)]
    update_count: u64,
    #[serde(skip_serializing)]
    last_update_millis: u128,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BulletSummary {
    id: u64,
    owner_slot: u8,
    x: f32,
    y: f32,
    heading: f32,
    radius: f32,
    kind: ProjectileKind,
    #[serde(skip_serializing)]
    lifetime: f32,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum ProjectileKind {
    Bullet,
    Grenade,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WallCrater {
    x: f32,
    y: f32,
    radius: f32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BlastSummary {
    id: u64,
    x: f32,
    y: f32,
    radius: f32,
    started_at_tick: u64,
    ends_at_tick: u64,
}

#[derive(Debug, Clone, Default)]
struct ControlInput {
    accelerate: bool,
    brake: bool,
    turn_left: bool,
    turn_right: bool,
    fire: bool,
    grenade: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlayerInputRequest {
    token: String,
    sequence: u64,
    accelerate: bool,
    brake: bool,
    turn_left: bool,
    turn_right: bool,
    fire: bool,
    #[serde(default)]
    grenade: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateRoomRequest {
    nickname: String,
    map_id: String,
    death_limit: Option<u16>,
}

#[derive(Debug, Deserialize)]
struct JoinRoomRequest {
    nickname: String,
}

#[derive(Debug, Deserialize)]
struct AuthRequest {
    token: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CreateRoomResponse {
    room: Room,
    invite_path: String,
    session_token: String,
    slot: u8,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct JoinRoomResponse {
    room: Room,
    session_token: String,
    slot: u8,
}

#[derive(Debug, Serialize)]
struct ApiErrorBody {
    error: String,
}

struct ApiError(StatusCode, &'static str);

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            self.0,
            Json(ApiErrorBody {
                error: self.1.to_owned(),
            }),
        )
            .into_response()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ServerConfig {
    host: String,
    port: u16,
}

impl ServerConfig {
    fn from_env() -> Self {
        let host = env::var("SERVER_HOST").unwrap_or_else(|_| "0.0.0.0".to_owned());
        let port = env::var("SERVER_PORT")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(8080);
        Self { host, port }
    }

    fn address(&self) -> String {
        format!("{}:{}", self.host, self.port)
    }
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt::init();
    let config = ServerConfig::from_env();
    let listener = tokio::net::TcpListener::bind(config.address())
        .await
        .expect("failed to bind server listener");
    let address = listener.local_addr().expect("server listener address");
    println!("Paint Arena server listening on http://{address}");
    axum::serve(listener, app()).await.expect("server exited");
}

fn app() -> Router {
    let state = AppState::new();
    spawn_room_tick_loop(state.clone());
    let web_dist_dir = env::var("WEB_DIST_DIR").unwrap_or_else(|_| "web/dist".to_owned());
    let web_index = format!("{web_dist_dir}/index.html");
    let web_service = ServeDir::new(web_dist_dir).fallback(ServeFile::new(web_index));

    Router::new()
        .route("/api/maps", get(list_maps).post(create_custom_map))
        .route("/api/maps/{map_id}/map.png", get(get_map_png))
        .route("/api/monitor", get(monitor_snapshot))
        .route("/monitor", get(monitor_page))
        .route("/api/rooms", post(create_room))
        .route("/api/rooms/{room_id}", get(get_room))
        .route("/api/rooms/{room_id}/join", post(join_room))
        .route("/api/rooms/{room_id}/start", post(start_room))
        .route("/api/rooms/{room_id}/rematch", post(rematch_room))
        .route(
            "/api/rooms/{room_id}/players/{slot}/input",
            post(set_player_input),
        )
        .route(
            "/api/rooms/{room_id}/players/{slot}/leave",
            post(leave_room),
        )
        .route("/ws/rooms/{room_id}", get(room_ws_handler))
        .route("/ws", get(ws_handler))
        .with_state(state)
        .fallback_service(web_service)
}

fn load_builtin_maps() -> HashMap<String, GameMap> {
    [
        (
            "level1",
            "Level 1",
            "/api/maps/level1/map.png?v=2",
            include_bytes!("../../maps/builtin/level1/map.png").as_slice(),
            include_bytes!("../../maps/builtin/level1/map.json").as_slice(),
        ),
        (
            "switchback-basin",
            "Switchback Basin",
            "/api/maps/switchback-basin/map.png?v=2",
            include_bytes!("../../maps/builtin/switchback-basin/map.png").as_slice(),
            include_bytes!("../../maps/builtin/switchback-basin/map.json").as_slice(),
        ),
        (
            "clover-junction",
            "Clover Junction",
            "/api/maps/clover-junction/map.png?v=2",
            include_bytes!("../../maps/builtin/clover-junction/map.png").as_slice(),
            include_bytes!("../../maps/builtin/clover-junction/map.json").as_slice(),
        ),
    ]
    .into_iter()
    .map(|(id, name, image_url, image_bytes, manifest_bytes)| {
        let compiled = decode_and_validate_png(image_bytes)
            .unwrap_or_else(|error| panic!("invalid built-in map {id}: {error:?}"));
        let manifest = serde_json::from_slice(manifest_bytes)
            .unwrap_or_else(|error| panic!("invalid built-in map manifest {id}: {error}"));
        (
            id.to_owned(),
            GameMap {
                id: id.to_owned(),
                name: name.to_owned(),
                image_url: image_url.to_owned(),
                image_bytes: Arc::new(image_bytes.to_vec()),
                compiled: Arc::new(compiled),
                manifest: Arc::new(manifest),
            },
        )
    })
    .collect()
}

async fn list_maps(State(state): State<AppState>) -> Json<Vec<MapSummary>> {
    let maps = state.maps.lock().expect("maps lock");
    let mut maps = maps.values().collect::<Vec<_>>();
    maps.sort_by_key(|map| match map.id.as_str() {
        "level1" => 0,
        "switchback-basin" => 1,
        "clover-junction" => 2,
        _ => 3,
    });
    Json(
        maps.into_iter()
            .map(|map| MapSummary {
                preview_spawn_x: map.spawn_for(1, 0).0,
                preview_spawn_y: map.spawn_for(1, 0).1,
                preview_player_color: map.player_color(1).to_owned(),
                metro_stations: map
                    .manifest
                    .metro_stations
                    .iter()
                    .map(|station| station.location)
                    .collect(),
                id: map.id.clone(),
                name: map.name.clone(),
                image_url: map.image_url.clone(),
                width: map.compiled.width,
                height: map.compiled.height,
                number_of_players: map.manifest.number_of_players,
            })
            .collect(),
    )
}

async fn get_map_png(
    State(state): State<AppState>,
    Path(map_id): Path<String>,
) -> Result<Response, ApiError> {
    let map = get_map(&state, &map_id).ok_or(ApiError(StatusCode::NOT_FOUND, "map not found"))?;
    Ok((
        [
            (header::CONTENT_TYPE, "image/png"),
            (header::CACHE_CONTROL, "public, max-age=3600"),
        ],
        map.image_bytes.as_ref().clone(),
    )
        .into_response())
}

async fn create_custom_map(
    State(state): State<AppState>,
    Json(request): Json<CustomMapRequest>,
) -> Result<Json<MapSummary>, ApiError> {
    let id = loop {
        let candidate = format!("custom-{}", generate_token(10).to_ascii_lowercase());
        if !state
            .maps
            .lock()
            .expect("maps lock")
            .contains_key(&candidate)
        {
            break candidate;
        }
    };
    let map = build_custom_map(&id, &request)
        .map_err(|_| ApiError(StatusCode::BAD_REQUEST, "invalid custom map"))?;
    persist_custom_map(&state.custom_map_dir, &id, &request).map_err(|_| {
        ApiError(
            StatusCode::INTERNAL_SERVER_ERROR,
            "could not save custom map",
        )
    })?;
    let summary = map_summary(&map);
    state.maps.lock().expect("maps lock").insert(id, map);
    Ok(Json(summary))
}

fn get_map(state: &AppState, map_id: &str) -> Option<GameMap> {
    state.maps.lock().expect("maps lock").get(map_id).cloned()
}

fn map_summary(map: &GameMap) -> MapSummary {
    MapSummary {
        preview_spawn_x: map.spawn_for(1, 0).0,
        preview_spawn_y: map.spawn_for(1, 0).1,
        preview_player_color: map.player_color(1).to_owned(),
        metro_stations: map
            .manifest
            .metro_stations
            .iter()
            .map(|station| station.location)
            .collect(),
        id: map.id.clone(),
        name: map.name.clone(),
        image_url: map.image_url.clone(),
        width: map.compiled.width,
        height: map.compiled.height,
        number_of_players: map.manifest.number_of_players,
    }
}

fn build_custom_map(id: &str, request: &CustomMapRequest) -> Result<GameMap, ()> {
    if request.width < MIN_CUSTOM_MAP_WIDTH
        || request.height < MIN_CUSTOM_MAP_HEIGHT
        || request.width > MAX_CUSTOM_MAP_WIDTH
        || request.height > MAX_CUSTOM_MAP_HEIGHT
        || !(2..=MAX_CUSTOM_PLAYERS).contains(&request.players.len())
        || request.metro_stations.len() > MAX_CUSTOM_METROS
        || request.metro_stations.len() == 1
    {
        return Err(());
    }
    let name = sanitize_map_name(&request.name);
    if name.is_empty() {
        return Err(());
    }
    let mask = BASE64.decode(&request.wall_mask).map_err(|_| ())?;
    let expected = usize::from(request.width) * usize::from(request.height);
    if mask.len() != expected || mask.iter().any(|pixel| *pixel > 1) {
        return Err(());
    }
    let walls = mask.iter().map(|pixel| *pixel == 1).collect::<Vec<_>>();
    let compiled =
        ValidatedMap::from_wall_pixels(request.width, request.height, walls).map_err(|_| ())?;

    for player in &request.players {
        if parse_hex_color(&player.color).is_none()
            || player.color.eq_ignore_ascii_case("#800000")
            || !valid_open_location(&compiled, player.location, PLAYER_RADIUS)
        {
            return Err(());
        }
    }
    for location in &request.metro_stations {
        if !valid_open_location(&compiled, *location, PLAYER_RADIUS + 8.0) {
            return Err(());
        }
    }

    let manifest = MapManifest {
        number_of_players: request.players.len() as u8,
        players: request
            .players
            .iter()
            .enumerate()
            .map(|(index, player)| MapPlayerDefinition {
                slot: index as u8 + 1,
                color: player.color.to_ascii_uppercase(),
                spawn_locations: vec![player.location],
            })
            .collect(),
        metro_stations: request
            .metro_stations
            .iter()
            .enumerate()
            .map(|(index, location)| MetroStationDefinition {
                _id: format!("M{}", index + 1),
                _color: "#0080FF".to_owned(),
                location: *location,
            })
            .collect(),
    };
    let image_bytes = render_custom_map_png(&compiled, &manifest)?;
    Ok(GameMap {
        id: id.to_owned(),
        name,
        image_url: format!("/api/maps/{id}/map.png"),
        image_bytes: Arc::new(image_bytes),
        compiled: Arc::new(compiled),
        manifest: Arc::new(manifest),
    })
}

fn valid_open_location(map: &ValidatedMap, location: MapLocation, radius: f32) -> bool {
    location.x.is_finite()
        && location.y.is_finite()
        && location.x >= radius
        && location.y >= radius
        && location.x < f32::from(map.width) - radius
        && location.y < f32::from(map.height) - radius
        && map.can_occupy(location.x, location.y, radius)
}

fn sanitize_map_name(name: &str) -> String {
    name.trim()
        .chars()
        .filter(|character| !character.is_control())
        .take(40)
        .collect()
}

fn parse_hex_color(color: &str) -> Option<Rgb> {
    let value = color.strip_prefix('#')?;
    if value.len() != 6 {
        return None;
    }
    Some(Rgb::new(
        u8::from_str_radix(&value[0..2], 16).ok()?,
        u8::from_str_radix(&value[2..4], 16).ok()?,
        u8::from_str_radix(&value[4..6], 16).ok()?,
    ))
}

fn render_custom_map_png(map: &ValidatedMap, manifest: &MapManifest) -> Result<Vec<u8>, ()> {
    let width = usize::from(map.width);
    let height = usize::from(map.height);
    let mut pixels = vec![0; width * height * 3];
    for y in 0..height {
        for x in 0..width {
            let color = if map.is_wall(x as f32, y as f32) {
                WALL
            } else {
                FLOOR
            };
            set_rgb_pixel(&mut pixels, width, x, y, color);
        }
    }
    for station in &manifest.metro_stations {
        paint_square(&mut pixels, width, height, station.location, 12, METRO);
    }
    for player in &manifest.players {
        if let (Some(location), Some(color)) = (
            player.spawn_locations.first(),
            parse_hex_color(&player.color),
        ) {
            paint_circle(&mut pixels, width, height, *location, 9, color);
        }
    }

    let mut encoded = Vec::new();
    {
        let mut encoder =
            png::Encoder::new(&mut encoded, u32::from(map.width), u32::from(map.height));
        encoder.set_color(png::ColorType::Rgb);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().map_err(|_| ())?;
        writer.write_image_data(&pixels).map_err(|_| ())?;
    }
    Ok(encoded)
}

fn set_rgb_pixel(pixels: &mut [u8], width: usize, x: usize, y: usize, color: Rgb) {
    let index = (y * width + x) * 3;
    pixels[index] = color.red;
    pixels[index + 1] = color.green;
    pixels[index + 2] = color.blue;
}

fn paint_square(
    pixels: &mut [u8],
    width: usize,
    height: usize,
    location: MapLocation,
    radius: usize,
    color: Rgb,
) {
    let center_x = location.x.round() as usize;
    let center_y = location.y.round() as usize;
    for y in center_y.saturating_sub(radius)..=(center_y + radius).min(height - 1) {
        for x in center_x.saturating_sub(radius)..=(center_x + radius).min(width - 1) {
            set_rgb_pixel(pixels, width, x, y, color);
        }
    }
}

fn paint_circle(
    pixels: &mut [u8],
    width: usize,
    height: usize,
    location: MapLocation,
    radius: usize,
    color: Rgb,
) {
    let center_x = location.x.round() as usize;
    let center_y = location.y.round() as usize;
    for y in center_y.saturating_sub(radius)..=(center_y + radius).min(height - 1) {
        for x in center_x.saturating_sub(radius)..=(center_x + radius).min(width - 1) {
            let dx = x.abs_diff(center_x);
            let dy = y.abs_diff(center_y);
            if dx * dx + dy * dy <= radius * radius {
                set_rgb_pixel(pixels, width, x, y, color);
            }
        }
    }
}

fn persist_custom_map(dir: &FilePath, id: &str, map: &CustomMapRequest) -> std::io::Result<()> {
    fs::create_dir_all(dir)?;
    let bytes = serde_json::to_vec_pretty(&SavedCustomMap {
        id: id.to_owned(),
        map: map.clone(),
    })?;
    fs::write(dir.join(format!("{id}.json")), bytes)
}

fn load_saved_custom_maps(dir: &FilePath, maps: &mut HashMap<String, GameMap>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(bytes) = fs::read(entry.path()) else {
            continue;
        };
        let Ok(saved) = serde_json::from_slice::<SavedCustomMap>(&bytes) else {
            continue;
        };
        if let Ok(map) = build_custom_map(&saved.id, &saved.map) {
            maps.insert(saved.id, map);
        }
    }
}

async fn create_room(
    State(state): State<AppState>,
    Json(request): Json<CreateRoomRequest>,
) -> Result<Json<CreateRoomResponse>, ApiError> {
    let map =
        get_map(&state, &request.map_id).ok_or(ApiError(StatusCode::BAD_REQUEST, "unknown map"))?;
    let room_id = unique_room_id(&state);
    let token = generate_token(32);
    let host = player_for_slot(&room_id, 1, true, &request.nickname, token.clone(), &map);
    let room = Room {
        id: room_id.clone(),
        map_id: request.map_id,
        death_limit: request.death_limit.unwrap_or(10).clamp(1, 99),
        player_limit: map.manifest.number_of_players,
        phase: RoomPhase::Lobby,
        phase_ends_at_tick: None,
        winner_slot: None,
        tick: 0,
        players: vec![host],
        bullets: Vec::new(),
        wall_craters: Vec::new(),
        wall_pixels: map.compiled.wall_pixels(),
        blasts: Vec::new(),
        feed: Vec::new(),
        next_bullet_id: 1,
        next_blast_id: 1,
        last_activity_millis: now_millis(),
    };
    state
        .rooms
        .lock()
        .expect("rooms lock")
        .insert(room_id.clone(), room.clone());
    let (sender, _) = watch::channel(serialize_room(&room));
    state
        .room_streams
        .lock()
        .expect("room streams lock")
        .insert(room_id.clone(), sender);
    state.metrics.lock().expect("metrics lock").created_rooms += 1;
    Ok(Json(CreateRoomResponse {
        room,
        invite_path: format!("/game/{room_id}"),
        session_token: token,
        slot: 1,
    }))
}

async fn get_room(
    State(state): State<AppState>,
    Path(room_id): Path<String>,
) -> Result<Json<Room>, ApiError> {
    state.metrics.lock().expect("metrics lock").room_gets += 1;
    state
        .rooms
        .lock()
        .expect("rooms lock")
        .get(&room_id)
        .cloned()
        .map(Json)
        .ok_or(ApiError(StatusCode::NOT_FOUND, "room not found"))
}

async fn join_room(
    State(state): State<AppState>,
    Path(room_id): Path<String>,
    Json(request): Json<JoinRoomRequest>,
) -> Result<Json<JoinRoomResponse>, ApiError> {
    let map_id = state
        .rooms
        .lock()
        .expect("rooms lock")
        .get(&room_id)
        .map(|room| room.map_id.clone())
        .ok_or(ApiError(StatusCode::NOT_FOUND, "room not found"))?;
    let map = get_map(&state, &map_id).expect("room map");
    let mut rooms = state.rooms.lock().expect("rooms lock");
    let room = rooms.get_mut(&room_id).expect("room exists");
    if !matches!(room.phase, RoomPhase::Lobby | RoomPhase::Countdown)
        || room.players.len() >= usize::from(room.player_limit)
    {
        return Err(ApiError(StatusCode::CONFLICT, "room is not joinable"));
    }

    let slot = room
        .players
        .iter()
        .map(|player| player.slot)
        .max()
        .unwrap_or(0)
        + 1;
    let token = generate_token(32);
    room.players.push(player_for_slot(
        &room_id,
        slot,
        false,
        &request.nickname,
        token.clone(),
        &map,
    ));
    if room.phase == RoomPhase::Lobby {
        room.phase = RoomPhase::Countdown;
        room.phase_ends_at_tick = Some(room.tick + COUNTDOWN_TICKS);
    }
    room.last_activity_millis = now_millis();
    push_feed(room, "Match starts in 3 seconds".to_owned());
    publish_room(&state, room);
    state.metrics.lock().expect("metrics lock").joins += 1;
    Ok(Json(JoinRoomResponse {
        room: room.clone(),
        session_token: token,
        slot,
    }))
}

async fn set_player_input(
    State(state): State<AppState>,
    Path((room_id, slot)): Path<(String, u8)>,
    Json(request): Json<PlayerInputRequest>,
) -> Result<StatusCode, ApiError> {
    let mut rooms = state.rooms.lock().expect("rooms lock");
    let room = rooms
        .get_mut(&room_id)
        .ok_or(ApiError(StatusCode::NOT_FOUND, "room not found"))?;
    let player = room
        .players
        .iter_mut()
        .find(|player| player.slot == slot)
        .ok_or(ApiError(StatusCode::NOT_FOUND, "player not found"))?;
    if !constant_time_eq(&player.session_token, &request.token) {
        return Err(ApiError(StatusCode::UNAUTHORIZED, "invalid player token"));
    }
    if request.sequence <= player.last_input_sequence {
        return Ok(StatusCode::NO_CONTENT);
    }

    player.last_input_sequence = request.sequence;
    player.input = ControlInput {
        accelerate: request.accelerate,
        brake: request.brake,
        turn_left: request.turn_left,
        turn_right: request.turn_right,
        fire: request.fire,
        grenade: request.grenade,
    };
    player.update_count += 1;
    player.last_update_millis = now_millis();
    room.last_activity_millis = now_millis();
    state.metrics.lock().expect("metrics lock").input_posts += 1;
    Ok(StatusCode::NO_CONTENT)
}

async fn leave_room(
    State(state): State<AppState>,
    Path((room_id, slot)): Path<(String, u8)>,
    Json(request): Json<AuthRequest>,
) -> Result<StatusCode, ApiError> {
    let mut rooms = state.rooms.lock().expect("rooms lock");
    let room = rooms
        .get(&room_id)
        .ok_or(ApiError(StatusCode::NOT_FOUND, "room not found"))?;
    let player = room
        .players
        .iter()
        .find(|player| player.slot == slot)
        .ok_or(ApiError(StatusCode::NOT_FOUND, "player not found"))?;
    if !constant_time_eq(&player.session_token, &request.token) {
        return Err(ApiError(StatusCode::UNAUTHORIZED, "invalid player token"));
    }

    if player.host {
        rooms.remove(&room_id);
        state
            .room_streams
            .lock()
            .expect("room streams lock")
            .remove(&room_id);
    } else {
        let room = rooms.get_mut(&room_id).expect("room exists");
        room.players.retain(|player| player.slot != slot);
        room.phase = RoomPhase::Lobby;
        room.phase_ends_at_tick = None;
        room.winner_slot = None;
        room.bullets.clear();
        room.wall_craters.clear();
        let map = get_map(&state, &room.map_id).expect("room map");
        room.wall_pixels = map.compiled.wall_pixels();
        room.blasts.clear();
        room.feed.clear();
        if let Some(host) = room.players.first_mut() {
            host.kills = 0;
            host.deaths = 0;
            respawn_player(host, &map, room.tick);
            host.invulnerable_until_tick = 0;
        }
        publish_room(&state, room);
    }
    Ok(StatusCode::NO_CONTENT)
}

async fn start_room(
    State(state): State<AppState>,
    Path(room_id): Path<String>,
    Json(request): Json<AuthRequest>,
) -> Result<Json<Room>, ApiError> {
    let mut rooms = state.rooms.lock().expect("rooms lock");
    let room = rooms
        .get_mut(&room_id)
        .ok_or(ApiError(StatusCode::NOT_FOUND, "room not found"))?;
    authorize_host(room, &request.token)?;
    if room.players.len() < 2 || room.phase != RoomPhase::Lobby {
        return Err(ApiError(StatusCode::CONFLICT, "room cannot start"));
    }
    room.phase = RoomPhase::Countdown;
    room.phase_ends_at_tick = Some(room.tick + COUNTDOWN_TICKS);
    publish_room(&state, room);
    Ok(Json(room.clone()))
}

async fn rematch_room(
    State(state): State<AppState>,
    Path(room_id): Path<String>,
    Json(request): Json<AuthRequest>,
) -> Result<Json<Room>, ApiError> {
    let mut rooms = state.rooms.lock().expect("rooms lock");
    let room = rooms
        .get_mut(&room_id)
        .ok_or(ApiError(StatusCode::NOT_FOUND, "room not found"))?;
    authorize_host(room, &request.token)?;
    if room.phase != RoomPhase::Ended {
        return Err(ApiError(StatusCode::CONFLICT, "match has not ended"));
    }
    let map = get_map(&state, &room.map_id).expect("room map");
    room.tick = 0;
    room.phase = RoomPhase::Countdown;
    room.phase_ends_at_tick = Some(COUNTDOWN_TICKS);
    room.winner_slot = None;
    room.bullets.clear();
    room.wall_craters.clear();
    room.wall_pixels = map.compiled.wall_pixels();
    room.blasts.clear();
    room.feed.clear();
    for player in &mut room.players {
        player.kills = 0;
        player.deaths = 0;
        respawn_player(player, &map, 0);
        player.invulnerable_until_tick = 0;
    }
    push_feed(room, "Rematch starts in 3 seconds".to_owned());
    publish_room(&state, room);
    Ok(Json(room.clone()))
}

fn authorize_host(room: &Room, token: &str) -> Result<(), ApiError> {
    let host = room
        .players
        .iter()
        .find(|player| player.host)
        .expect("room host");
    if constant_time_eq(&host.session_token, token) {
        Ok(())
    } else {
        Err(ApiError(StatusCode::UNAUTHORIZED, "host token required"))
    }
}

fn spawn_room_tick_loop(state: AppState) {
    tokio::spawn(async move {
        let mut ticker = interval(Duration::from_millis(1000 / TICK_RATE_HZ));
        loop {
            ticker.tick().await;
            let started = Instant::now();
            let now = now_millis();
            let mut rooms = state.rooms.lock().expect("rooms lock");
            rooms.retain(|_, room| {
                now.saturating_sub(room.last_activity_millis) < ROOM_EXPIRY_MILLIS
            });
            for room in rooms.values_mut() {
                let map = get_map(&state, &room.map_id).expect("room map");
                let should_publish =
                    matches!(room.phase, RoomPhase::Countdown | RoomPhase::Playing);
                tick_room(room, &map, TICK_SECONDS);
                if should_publish {
                    publish_room(&state, room);
                }
            }
            drop(rooms);
            let elapsed_ms = started.elapsed().as_secs_f32() * 1000.0;
            let mut metrics = state.metrics.lock().expect("metrics lock");
            metrics.ticks += 1;
            metrics.last_tick_ms = elapsed_ms;
            metrics.max_tick_ms = metrics.max_tick_ms.max(elapsed_ms);
        }
    });
}

fn tick_room(room: &mut Room, map: &GameMap, dt: f32) {
    if matches!(room.phase, RoomPhase::Lobby | RoomPhase::Ended) {
        return;
    }
    room.tick += 1;
    room.blasts.retain(|blast| room.tick < blast.ends_at_tick);

    if room.phase == RoomPhase::Countdown {
        if room.tick >= room.phase_ends_at_tick.unwrap_or(u64::MAX) {
            room.phase = RoomPhase::Playing;
            room.phase_ends_at_tick = None;
            for player in &mut room.players {
                player.input = ControlInput::default();
            }
            push_feed(room, "Fight!".to_owned());
        }
        return;
    }

    let mut spawned = Vec::new();
    let mut respawned = Vec::new();
    let wall_pixels = &room.wall_pixels;
    for player in &mut room.players {
        if player.state == PlayerState::Respawning {
            if room.tick >= player.respawn_at_tick.unwrap_or(u64::MAX) {
                respawn_player(player, map, room.tick);
                respawned.push(player.nickname.clone());
            }
            continue;
        }

        player.fire_cooldown = (player.fire_cooldown - dt).max(0.0);
        player.metro_cooldown = (player.metro_cooldown - dt).max(0.0);
        player.grenade_cooldown = (player.grenade_cooldown - dt).max(0.0);
        simulate_player_movement(player, map, wall_pixels, dt);

        if player.metro_cooldown <= 0.0
            && let Some((x, y)) = map.metro_destination(player.x, player.y, PLAYER_RADIUS)
        {
            player.x = x;
            player.y = y;
            player.speed = 0.0;
            player.metro_cooldown = METRO_COOLDOWN_SECONDS;
        }

        if player.input.fire && player.fire_cooldown <= 0.0 {
            spawned.push(BulletSummary {
                id: room.next_bullet_id,
                owner_slot: player.slot,
                x: player.x + player.heading.cos() * (PLAYER_RADIUS + 6.0),
                y: player.y + player.heading.sin() * (PLAYER_RADIUS + 6.0),
                heading: player.heading,
                radius: BULLET_RADIUS,
                kind: ProjectileKind::Bullet,
                lifetime: f32::INFINITY,
            });
            room.next_bullet_id += 1;
            player.fire_cooldown = FIRE_COOLDOWN_SECONDS;
        }
        if player.input.grenade && player.grenade_cooldown <= 0.0 {
            spawned.push(BulletSummary {
                id: room.next_bullet_id,
                owner_slot: player.slot,
                x: player.x + player.heading.cos() * (PLAYER_RADIUS + 8.0),
                y: player.y + player.heading.sin() * (PLAYER_RADIUS + 8.0),
                heading: player.heading,
                radius: 5.0,
                kind: ProjectileKind::Grenade,
                lifetime: GRENADE_LIFETIME_SECONDS,
            });
            room.next_bullet_id += 1;
            player.grenade_cooldown = GRENADE_COOLDOWN_SECONDS;
        }
    }
    for nickname in respawned {
        push_feed(room, format!("{nickname} respawned"));
    }
    room.bullets.extend(spawned);
    update_bullets(room, map, dt);
}

fn simulate_player_movement(
    player: &mut PlayerSummary,
    map: &GameMap,
    wall_pixels: &[bool],
    dt: f32,
) {
    let turn = f32::from(player.input.turn_right) - f32::from(player.input.turn_left);
    let moving_factor = 0.35 + (player.speed / MAX_SPEED).clamp(0.0, 1.0) * 0.65;
    player.heading += turn * moving_factor * TURN_SPEED * dt;
    if player.input.accelerate {
        player.speed = (player.speed + ACCELERATION * dt).min(MAX_SPEED);
    } else if player.input.brake {
        player.speed = (player.speed - BRAKING * dt).max(0.0);
    } else {
        player.speed = (player.speed - FRICTION * dt).max(0.0);
    }

    let clearance = wall_clearance(map, wall_pixels, player.x, player.y, WALL_FIELD_RADIUS);
    let field_strength =
        ((clearance - PLAYER_RADIUS) / (WALL_FIELD_RADIUS - PLAYER_RADIUS)).clamp(0.0, 1.0);
    let dissipation = 1.0 - (1.0 - field_strength).powi(2) * (dt * 18.0).min(0.85);
    player.speed *= dissipation;

    let distance = player.speed * dt;
    let steps = (distance / 2.0).ceil().max(1.0) as usize;
    let step_x = player.heading.cos() * distance / steps as f32;
    let step_y = player.heading.sin() * distance / steps as f32;
    let mut collided = false;
    for _ in 0..steps {
        if can_occupy_dynamic(map, wall_pixels, player.x + step_x, player.y, PLAYER_RADIUS) {
            player.x += step_x;
        } else {
            collided = true;
        }
        if can_occupy_dynamic(map, wall_pixels, player.x, player.y + step_y, PLAYER_RADIUS) {
            player.y += step_y;
        } else {
            collided = true;
        }
    }
    if collided {
        player.speed *= 0.18;
    }
}

fn is_outside_arena(map: &GameMap, x: f32, y: f32) -> bool {
    !x.is_finite()
        || !y.is_finite()
        || x < 0.0
        || y < 0.0
        || x >= f32::from(map.compiled.width)
        || y >= f32::from(map.compiled.height)
}

fn is_wall_dynamic(map: &GameMap, wall_pixels: &[bool], x: f32, y: f32) -> bool {
    if is_outside_arena(map, x, y) {
        return true;
    }
    let pixel_x = x.floor() as usize;
    let pixel_y = y.floor() as usize;
    wall_pixels[pixel_y * usize::from(map.compiled.width) + pixel_x]
}

fn can_occupy_dynamic(map: &GameMap, wall_pixels: &[bool], x: f32, y: f32, radius: f32) -> bool {
    const SAMPLES: usize = 24;
    !is_wall_dynamic(map, wall_pixels, x, y)
        && (0..SAMPLES).all(|index| {
            let angle = index as f32 * std::f32::consts::TAU / SAMPLES as f32;
            !is_wall_dynamic(
                map,
                wall_pixels,
                x + angle.cos() * radius,
                y + angle.sin() * radius,
            )
        })
}

fn wall_clearance(map: &GameMap, wall_pixels: &[bool], x: f32, y: f32, maximum: f32) -> f32 {
    const RAYS: usize = 24;
    let mut distance = 0.0;
    while distance <= maximum {
        for ray in 0..RAYS {
            let angle = ray as f32 * std::f32::consts::TAU / RAYS as f32;
            if is_wall_dynamic(
                map,
                wall_pixels,
                x + angle.cos() * distance,
                y + angle.sin() * distance,
            ) {
                return distance;
            }
        }
        distance += 2.0;
    }
    maximum
}

fn update_bullets(room: &mut Room, map: &GameMap, dt: f32) {
    let bullets = std::mem::take(&mut room.bullets);
    let mut remaining = Vec::with_capacity(bullets.len());

    for mut bullet in bullets {
        if room.phase != RoomPhase::Playing {
            break;
        }
        let projectile_speed = match bullet.kind {
            ProjectileKind::Bullet => BULLET_SPEED,
            ProjectileKind::Grenade => GRENADE_SPEED,
        };
        let distance = projectile_speed * dt;
        let steps = (distance / bullet.radius).ceil().max(1.0) as usize;
        let step_x = bullet.heading.cos() * distance / steps as f32;
        let step_y = bullet.heading.sin() * distance / steps as f32;
        let mut consumed = false;

        for _ in 0..steps {
            bullet.x += step_x;
            bullet.y += step_y;
            if is_outside_arena(map, bullet.x, bullet.y) {
                consumed = true;
                break;
            }
            if bullet.kind == ProjectileKind::Bullet
                && is_wall_dynamic(map, &room.wall_pixels, bullet.x, bullet.y)
            {
                consumed = true;
                carve_wall(room, map, bullet.x, bullet.y, BULLET_CRATER_RADIUS);
                break;
            }
            if bullet.kind == ProjectileKind::Bullet
                && let Some(index) = room.players.iter().position(|player| {
                    player.slot != bullet.owner_slot
                        && player.state == PlayerState::Alive
                        && distance_squared(player.x, player.y, bullet.x, bullet.y)
                            <= (PLAYER_RADIUS + bullet.radius).powi(2)
                })
            {
                consumed = true;
                if room.tick >= room.players[index].invulnerable_until_tick {
                    damage_player(room, index, bullet.owner_slot, BULLET_DAMAGE);
                }
                break;
            }
        }

        if bullet.kind == ProjectileKind::Grenade {
            bullet.lifetime -= dt;
        }
        if bullet.kind == ProjectileKind::Grenade && !consumed && bullet.lifetime <= 0.0 {
            explode_grenade(room, map, bullet.x, bullet.y, bullet.owner_slot);
            consumed = true;
        }
        if !consumed {
            remaining.push(bullet);
        }
    }
    if room.phase == RoomPhase::Playing {
        room.bullets = remaining;
    }
}

fn carve_wall(room: &mut Room, map: &GameMap, x: f32, y: f32, radius: f32) {
    let minimum_x = (x - radius).floor().max(0.0) as usize;
    let maximum_x = (x + radius).ceil().min(f32::from(map.compiled.width) - 1.0) as usize;
    let minimum_y = (y - radius).floor().max(0.0) as usize;
    let maximum_y = (y + radius)
        .ceil()
        .min(f32::from(map.compiled.height) - 1.0) as usize;
    let radius_squared = radius.powi(2);
    let width = usize::from(map.compiled.width);

    for pixel_y in minimum_y..=maximum_y {
        for pixel_x in minimum_x..=maximum_x {
            if distance_squared(pixel_x as f32, pixel_y as f32, x, y) > radius_squared {
                continue;
            }
            let pixel = &mut room.wall_pixels[pixel_y * width + pixel_x];
            *pixel = false;
        }
    }
    room.wall_craters.push(WallCrater { x, y, radius });
}

fn explode_grenade(room: &mut Room, map: &GameMap, x: f32, y: f32, owner_slot: u8) {
    carve_wall(room, map, x, y, GRENADE_CRATER_RADIUS);
    room.blasts.push(BlastSummary {
        id: room.next_blast_id,
        x,
        y,
        radius: GRENADE_BLAST_RADIUS,
        started_at_tick: room.tick,
        ends_at_tick: room.tick + BLAST_VISIBLE_TICKS,
    });
    room.next_blast_id += 1;

    let victims = room
        .players
        .iter()
        .enumerate()
        .filter(|(_, player)| {
            player.state == PlayerState::Alive
                && room.tick >= player.invulnerable_until_tick
                && distance_squared(player.x, player.y, x, y) <= GRENADE_BLAST_RADIUS.powi(2)
        })
        .map(|(index, player)| {
            let distance = distance_squared(player.x, player.y, x, y).sqrt();
            let damage = (82.0 * (1.0 - distance / GRENADE_BLAST_RADIUS)).max(20.0) as u16;
            (index, damage)
        })
        .collect::<Vec<_>>();
    for (index, damage) in victims {
        if room.phase == RoomPhase::Playing {
            damage_player(room, index, owner_slot, damage);
        }
    }
    let owner_name = room
        .players
        .iter()
        .find(|player| player.slot == owner_slot)
        .map(|player| player.nickname.clone())
        .unwrap_or_else(|| "Unknown".to_owned());
    push_feed(room, format!("{owner_name} detonated a grenade"));
}

fn damage_player(room: &mut Room, victim_index: usize, killer_slot: u8, damage: u16) {
    let victim = &mut room.players[victim_index];
    victim.health = victim.health.saturating_sub(damage);
    if victim.health > 0 {
        return;
    }

    victim.deaths = victim.deaths.saturating_add(1);
    victim.state = PlayerState::Respawning;
    victim.respawn_at_tick = Some(room.tick + RESPAWN_TICKS);
    victim.speed = 0.0;
    victim.input = ControlInput::default();
    let victim_slot = victim.slot;
    let victim_name = victim.nickname.clone();
    let reached_limit = victim.deaths >= room.death_limit;

    let killer_name = if let Some(killer) = room
        .players
        .iter_mut()
        .find(|player| player.slot == killer_slot)
    {
        killer.kills = killer.kills.saturating_add(1);
        killer.nickname.clone()
    } else {
        "Environment".to_owned()
    };
    push_feed(room, format!("{killer_name} eliminated {victim_name}"));

    if reached_limit {
        room.phase = RoomPhase::Ended;
        room.phase_ends_at_tick = None;
        room.winner_slot = room
            .players
            .iter()
            .find(|player| player.slot != victim_slot)
            .map(|player| player.slot)
            .or(Some(killer_slot));
        room.bullets.clear();
        let winner_name = room
            .winner_slot
            .and_then(|slot| room.players.iter().find(|player| player.slot == slot))
            .map(|player| player.nickname.clone())
            .unwrap_or_else(|| "No one".to_owned());
        push_feed(room, format!("{winner_name} wins the match"));
    }
}

fn respawn_player(player: &mut PlayerSummary, map: &GameMap, tick: u64) {
    let (x, y) = map.spawn_for(player.slot, player.deaths);
    player.x = x;
    player.y = y;
    player.heading = if player.slot == 1 {
        0.0
    } else {
        std::f32::consts::PI
    };
    player.speed = 0.0;
    player.health = 100;
    player.state = PlayerState::Alive;
    player.respawn_at_tick = None;
    player.invulnerable_until_tick = tick + SPAWN_PROTECTION_TICKS;
    player.input = ControlInput::default();
    player.fire_cooldown = 0.0;
    player.metro_cooldown = METRO_COOLDOWN_SECONDS;
    player.grenade_cooldown = 0.0;
}

fn player_for_slot(
    room_id: &str,
    slot: u8,
    host: bool,
    nickname: &str,
    token: String,
    map: &GameMap,
) -> PlayerSummary {
    let (x, y) = map.spawn_for(slot, 0);
    PlayerSummary {
        id: format!("{room_id}-p{slot}"),
        nickname: sanitize_nickname(nickname),
        slot,
        color: map.player_color(slot).to_owned(),
        kills: 0,
        deaths: 0,
        host,
        x,
        y,
        heading: if slot == 1 { 0.0 } else { std::f32::consts::PI },
        speed: 0.0,
        health: 100,
        state: PlayerState::Alive,
        respawn_at_tick: None,
        invulnerable_until_tick: 0,
        session_token: token,
        input: ControlInput::default(),
        last_input_sequence: 0,
        fire_cooldown: 0.0,
        metro_cooldown: METRO_COOLDOWN_SECONDS,
        grenade_cooldown: 0.0,
        update_count: 0,
        last_update_millis: now_millis(),
    }
}

fn push_feed(room: &mut Room, message: String) {
    room.feed.push(message);
    if room.feed.len() > 6 {
        room.feed.remove(0);
    }
}

fn distance_squared(ax: f32, ay: f32, bx: f32, by: f32) -> f32 {
    (ax - bx).powi(2) + (ay - by).powi(2)
}

fn sanitize_nickname(nickname: &str) -> String {
    let sanitized = nickname
        .trim()
        .chars()
        .filter(|character| {
            character.is_ascii_alphanumeric() || *character == '-' || *character == '_'
        })
        .take(16)
        .collect::<String>();
    if sanitized.is_empty() {
        "Player".to_owned()
    } else {
        sanitized
    }
}

fn unique_room_id(state: &AppState) -> String {
    loop {
        let id = generate_token_from_alphabet(6, b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789");
        if !state.rooms.lock().expect("rooms lock").contains_key(&id) {
            return id;
        }
    }
}

fn generate_token(length: usize) -> String {
    generate_token_from_alphabet(
        length,
        b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
    )
}

fn generate_token_from_alphabet(length: usize, alphabet: &[u8]) -> String {
    let mut rng = rand::rng();
    (0..length)
        .map(|_| alphabet[rng.random_range(0..alphabet.len())] as char)
        .collect()
}

fn constant_time_eq(left: &str, right: &str) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.bytes()
        .zip(right.bytes())
        .fold(0_u8, |difference, (a, b)| difference | (a ^ b))
        == 0
}

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("time after epoch")
        .as_millis()
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MonitorSnapshot {
    uptime_seconds: u64,
    room_count: usize,
    active_players: usize,
    total_bullets: usize,
    room_gets: u64,
    input_posts: u64,
    created_rooms: u64,
    joins: u64,
    ticks: u64,
    last_tick_ms: f32,
    max_tick_ms: f32,
    websocket_connections: u64,
}

async fn monitor_snapshot(State(state): State<AppState>) -> Json<MonitorSnapshot> {
    let rooms = state.rooms.lock().expect("rooms lock");
    let metrics = state.metrics.lock().expect("metrics lock").clone();
    Json(MonitorSnapshot {
        uptime_seconds: metrics.started_at.elapsed().as_secs(),
        room_count: rooms.len(),
        active_players: rooms.values().map(|room| room.players.len()).sum(),
        total_bullets: rooms.values().map(|room| room.bullets.len()).sum(),
        room_gets: metrics.room_gets,
        input_posts: metrics.input_posts,
        created_rooms: metrics.created_rooms,
        joins: metrics.joins,
        ticks: metrics.ticks,
        last_tick_ms: metrics.last_tick_ms,
        max_tick_ms: metrics.max_tick_ms,
        websocket_connections: metrics.websocket_connections,
    })
}

async fn monitor_page() -> Html<&'static str> {
    Html(
        r#"<!doctype html><meta charset="utf-8"><title>Paint Arena Monitor</title>
<style>body{background:#050805;color:#7cff7c;font:14px monospace;white-space:pre-wrap}</style>
<body id="screen">loading...</body><script>
const screen=document.querySelector('#screen');async function refresh(){const d=await fetch('/api/monitor').then(r=>r.json());screen.textContent=JSON.stringify(d,null,2)}refresh();setInterval(refresh,1000)
</script>"#,
    )
}

async fn ws_handler(State(state): State<AppState>, ws: WebSocketUpgrade) -> impl IntoResponse {
    state
        .metrics
        .lock()
        .expect("metrics lock")
        .websocket_connections += 1;
    ws.on_upgrade(handle_socket)
}

async fn room_ws_handler(
    State(state): State<AppState>,
    Path(room_id): Path<String>,
    ws: WebSocketUpgrade,
) -> Result<Response, ApiError> {
    let receiver = state
        .room_streams
        .lock()
        .expect("room streams lock")
        .get(&room_id)
        .map(watch::Sender::subscribe)
        .ok_or(ApiError(StatusCode::NOT_FOUND, "room not found"))?;
    state
        .metrics
        .lock()
        .expect("metrics lock")
        .websocket_connections += 1;
    Ok(ws
        .on_upgrade(move |socket| handle_room_socket(socket, receiver))
        .into_response())
}

async fn handle_socket(mut socket: WebSocket) {
    let _ = socket
        .send(Message::Text("paint-arena:connected".into()))
        .await;
}

async fn handle_room_socket(mut socket: WebSocket, mut receiver: watch::Receiver<String>) {
    loop {
        let snapshot = receiver.borrow_and_update().clone();
        if socket.send(Message::Text(snapshot.into())).await.is_err() {
            break;
        }
        if receiver.changed().await.is_err() {
            break;
        }
    }
}

fn publish_room(state: &AppState, room: &Room) {
    if let Some(sender) = state
        .room_streams
        .lock()
        .expect("room streams lock")
        .get(&room.id)
    {
        sender.send_replace(serialize_room(room));
    }
}

fn serialize_room(room: &Room) -> String {
    serde_json::to_string(room).expect("room snapshot serialization")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn level_one() -> GameMap {
        load_builtin_maps().remove("level1").expect("level one map")
    }

    fn test_room(map: &GameMap) -> Room {
        Room {
            id: "TEST".to_owned(),
            map_id: "level1".to_owned(),
            death_limit: 2,
            player_limit: map.manifest.number_of_players,
            phase: RoomPhase::Playing,
            phase_ends_at_tick: None,
            winner_slot: None,
            tick: 10,
            players: vec![
                player_for_slot("TEST", 1, true, "One", "one".to_owned(), map),
                player_for_slot("TEST", 2, false, "Two", "two".to_owned(), map),
            ],
            bullets: Vec::new(),
            wall_craters: Vec::new(),
            wall_pixels: map.compiled.wall_pixels(),
            blasts: Vec::new(),
            feed: Vec::new(),
            next_bullet_id: 1,
            next_blast_id: 1,
            last_activity_millis: now_millis(),
        }
    }

    fn custom_map_request() -> CustomMapRequest {
        let width = MIN_CUSTOM_MAP_WIDTH;
        let height = MIN_CUSTOM_MAP_HEIGHT;
        let mut mask = vec![0_u8; usize::from(width) * usize::from(height)];
        for y in 70..110 {
            for x in 150..170 {
                mask[y * usize::from(width) + x] = 1;
            }
        }
        CustomMapRequest {
            name: "Brush Test".to_owned(),
            width,
            height,
            wall_mask: BASE64.encode(mask),
            players: vec![
                CustomPlayerDefinition {
                    color: "#12ADEF".to_owned(),
                    location: MapLocation { x: 40.0, y: 40.0 },
                },
                CustomPlayerDefinition {
                    color: "#EFAD12".to_owned(),
                    location: MapLocation { x: 280.0, y: 140.0 },
                },
            ],
            metro_stations: vec![
                MapLocation { x: 80.0, y: 140.0 },
                MapLocation { x: 240.0, y: 40.0 },
            ],
        }
    }

    fn horizontal_wall_edge(map: &GameMap) -> (f32, f32) {
        let wall_pixels = map.compiled.wall_pixels();
        for y in 20..u32::from(map.compiled.height) - 20 {
            for x in 20..u32::from(map.compiled.width) - 30 {
                let wall_x = x as f32;
                let wall_y = y as f32;
                if !map.compiled.is_wall(wall_x - 1.0, wall_y)
                    && map.compiled.is_wall(wall_x, wall_y)
                    && map.compiled.is_wall(wall_x + 20.0, wall_y)
                    && can_occupy_dynamic(
                        map,
                        &wall_pixels,
                        wall_x - PLAYER_RADIUS - 2.0,
                        wall_y,
                        PLAYER_RADIUS,
                    )
                {
                    return (wall_x, wall_y);
                }
            }
        }
        panic!("level one should contain a thick horizontal wall edge");
    }

    #[test]
    fn nickname_sanitizer_limits_and_filters_names() {
        assert_eq!(sanitize_nickname("  Alice!!  "), "Alice");
        assert_eq!(sanitize_nickname(""), "Player");
        assert_eq!(sanitize_nickname("abcdefghijklmnopq"), "abcdefghijklmnop");
    }

    #[test]
    fn map_manifest_drives_player_and_metro_locations() {
        let map = level_one();
        assert_eq!(map.manifest.number_of_players, 3);
        assert_eq!(map.player_color(1), "#FF00FF");
        assert_eq!(map.spawn_for(1, 0), (249.0, 96.0));
        assert_eq!(map.spawn_for(1, 1), (122.0, 662.0));
        assert_eq!(map.manifest.metro_stations.len(), 4);
        assert_eq!(
            map.metro_destination(1048.0, 215.0, PLAYER_RADIUS),
            Some((230.0, 367.0))
        );
    }

    #[test]
    fn custom_map_builds_playable_raster_and_manifest() {
        let map = build_custom_map("custom-test", &custom_map_request()).expect("custom map");

        assert_eq!(map.name, "Brush Test");
        assert_eq!(map.manifest.number_of_players, 2);
        assert_eq!(map.manifest.metro_stations.len(), 2);
        assert!(map.compiled.is_wall(160.0, 90.0));
        assert!(!map.compiled.is_wall(40.0, 40.0));
        assert!(map.image_bytes.starts_with(b"\x89PNG\r\n\x1a\n"));
    }

    #[test]
    fn custom_map_rejects_a_spawn_inside_a_wall() {
        let mut request = custom_map_request();
        request.players[0].location = MapLocation { x: 160.0, y: 90.0 };

        assert!(build_custom_map("custom-test", &request).is_err());
    }

    #[test]
    fn three_hits_cause_one_death_and_delayed_respawn() {
        let map = level_one();
        let mut room = test_room(&map);
        damage_player(&mut room, 1, 1, BULLET_DAMAGE);
        damage_player(&mut room, 1, 1, BULLET_DAMAGE);
        assert_eq!(room.players[1].deaths, 0);
        damage_player(&mut room, 1, 1, BULLET_DAMAGE);
        assert_eq!(room.players[1].deaths, 1);
        assert_eq!(room.players[0].kills, 1);
        assert_eq!(room.players[1].state, PlayerState::Respawning);
        assert_eq!(room.players[1].health, 0);
        let respawn_tick = room.players[1].respawn_at_tick.expect("respawn tick");
        room.tick = respawn_tick;
        tick_room(&mut room, &map, TICK_SECONDS);
        assert_eq!(room.players[1].state, PlayerState::Alive);
        assert_eq!(room.players[1].health, 100);
    }

    #[test]
    fn death_limit_ends_match_once() {
        let map = level_one();
        let mut room = test_room(&map);
        room.players[1].deaths = 1;
        room.players[1].health = BULLET_DAMAGE;
        damage_player(&mut room, 1, 1, BULLET_DAMAGE);
        assert_eq!(room.phase, RoomPhase::Ended);
        assert_eq!(room.winner_slot, Some(1));
        assert_eq!(room.players[1].deaths, 2);
    }

    #[test]
    fn spawn_protection_consumes_bullet_without_damage() {
        let map = level_one();
        let mut room = test_room(&map);
        let victim = &room.players[1];
        room.bullets.push(BulletSummary {
            id: 1,
            owner_slot: 1,
            x: victim.x - 5.0,
            y: victim.y,
            heading: 0.0,
            radius: BULLET_RADIUS,
            kind: ProjectileKind::Bullet,
            lifetime: 1.0,
        });
        room.players[1].invulnerable_until_tick = room.tick + 1;

        update_bullets(&mut room, &map, TICK_SECONDS);

        assert_eq!(room.players[1].health, 100);
        assert!(room.bullets.is_empty());
    }

    #[test]
    fn swept_movement_cannot_tunnel_through_a_wall() {
        let map = level_one();
        let wall_pixels = map.compiled.wall_pixels();
        let (wall_x, wall_y) = horizontal_wall_edge(&map);
        let mut player = player_for_slot("TEST", 1, true, "One", "one".to_owned(), &map);
        player.x = wall_x - PLAYER_RADIUS - 2.0;
        player.y = wall_y;
        player.heading = 0.0;
        player.speed = MAX_SPEED;
        player.input.accelerate = true;

        simulate_player_movement(&mut player, &map, &wall_pixels, 0.5);

        assert!(player.x < wall_x - PLAYER_RADIUS + 0.1);
        assert!(can_occupy_dynamic(
            &map,
            &wall_pixels,
            player.x,
            player.y,
            PLAYER_RADIUS
        ));
        assert!(player.speed < MAX_SPEED * 0.25);
    }

    #[test]
    fn bullet_impact_carves_a_small_wall_crater() {
        let map = level_one();
        let (wall_x, wall_y) = horizontal_wall_edge(&map);
        let mut room = test_room(&map);
        room.bullets.push(BulletSummary {
            id: 1,
            owner_slot: 1,
            x: wall_x - 4.0,
            y: wall_y,
            heading: 0.0,
            radius: BULLET_RADIUS,
            kind: ProjectileKind::Bullet,
            lifetime: 1.0,
        });

        update_bullets(&mut room, &map, TICK_SECONDS);

        assert!(room.bullets.is_empty());
        assert_eq!(room.wall_craters.len(), 1);
        let crater = &room.wall_craters[0];
        assert_eq!(crater.radius, BULLET_CRATER_RADIUS);
        assert!(map.compiled.is_wall(crater.x, crater.y));
        assert!(!is_wall_dynamic(
            &map,
            &room.wall_pixels,
            crater.x,
            crater.y
        ));
    }

    #[test]
    fn overlapping_impacts_keep_eating_new_wall_pixels() {
        let map = level_one();
        let (wall_x, wall_y) = horizontal_wall_edge(&map);
        let mut room = test_room(&map);

        carve_wall(&mut room, &map, wall_x + 5.0, wall_y, BULLET_CRATER_RADIUS);
        carve_wall(&mut room, &map, wall_x + 11.0, wall_y, BULLET_CRATER_RADIUS);

        assert_eq!(room.wall_craters.len(), 2);
        assert!(!is_wall_dynamic(
            &map,
            &room.wall_pixels,
            wall_x + 11.0,
            wall_y
        ));
    }

    #[test]
    fn bullet_does_not_expire_in_mid_air() {
        let map = level_one();
        let mut room = test_room(&map);
        let owner = room.players.remove(0);
        room.players.clear();
        room.players.push(owner);
        room.bullets.push(BulletSummary {
            id: 1,
            owner_slot: 1,
            x: room.players[0].x,
            y: room.players[0].y,
            heading: 0.0,
            radius: BULLET_RADIUS,
            kind: ProjectileKind::Bullet,
            lifetime: 0.0,
        });

        update_bullets(&mut room, &map, TICK_SECONDS);

        assert_eq!(room.bullets.len(), 1);
        assert!(room.bullets[0].x > room.players[0].x);
    }

    #[test]
    fn bullet_is_removed_after_leaving_the_arena() {
        let map = level_one();
        let mut room = test_room(&map);
        room.bullets.push(BulletSummary {
            id: 1,
            owner_slot: 1,
            x: f32::from(map.compiled.width) - 1.0,
            y: f32::from(map.compiled.height) / 2.0,
            heading: 0.0,
            radius: BULLET_RADIUS,
            kind: ProjectileKind::Bullet,
            lifetime: f32::INFINITY,
        });

        update_bullets(&mut room, &map, TICK_SECONDS);

        assert!(room.bullets.is_empty());
        assert!(room.wall_craters.is_empty());
    }

    #[test]
    fn grenade_crosses_wall_and_creates_radial_blast() {
        let map = level_one();
        let (wall_x, wall_y) = horizontal_wall_edge(&map);
        let mut room = test_room(&map);
        room.bullets.push(BulletSummary {
            id: 1,
            owner_slot: 1,
            x: wall_x - 4.0,
            y: wall_y,
            heading: 0.0,
            radius: 5.0,
            kind: ProjectileKind::Grenade,
            lifetime: TICK_SECONDS / 2.0,
        });

        update_bullets(&mut room, &map, TICK_SECONDS);

        assert!(room.bullets.is_empty());
        assert_eq!(room.blasts.len(), 1);
        assert!(room.blasts[0].x > wall_x);
        assert!(map.compiled.is_wall(room.blasts[0].x, room.blasts[0].y));
        assert_eq!(room.wall_craters[0].radius, GRENADE_CRATER_RADIUS);
        assert_eq!(room.blasts[0].radius, GRENADE_BLAST_RADIUS);
    }

    #[test]
    fn stale_input_tokens_compare_safely() {
        assert!(constant_time_eq("same", "same"));
        assert!(!constant_time_eq("same", "diff"));
        assert!(!constant_time_eq("short", "longer"));
    }
}
