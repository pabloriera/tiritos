use super::palette::{Rgb, SemanticColor, classify_rgb};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Coordinate {
    pub x: u16,
    pub y: u16,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ValidatedMap {
    pub width: u16,
    pub height: u16,
    walls: Vec<bool>,
}

impl ValidatedMap {
    pub fn is_wall(&self, x: f32, y: f32) -> bool {
        if !x.is_finite() || !y.is_finite() || x < 0.0 || y < 0.0 {
            return true;
        }

        let x = x.floor() as usize;
        let y = y.floor() as usize;
        if x >= usize::from(self.width) || y >= usize::from(self.height) {
            return true;
        }

        self.walls[y * usize::from(self.width) + x]
    }

    pub fn can_occupy(&self, x: f32, y: f32, radius: f32) -> bool {
        const SAMPLES: usize = 16;
        (0..SAMPLES).all(|index| {
            let angle = index as f32 * std::f32::consts::TAU / SAMPLES as f32;
            !self.is_wall(x + angle.cos() * radius, y + angle.sin() * radius)
        }) && !self.is_wall(x, y)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ValidationError {
    EmptyMap,
    DimensionMismatch { expected: usize, actual: usize },
    UnknownColor { coordinate: Coordinate, rgb: Rgb },
    MissingFloor,
}

pub fn validate_pixels(
    width: u16,
    height: u16,
    pixels: &[Rgb],
) -> Result<ValidatedMap, ValidationError> {
    if width == 0 || height == 0 {
        return Err(ValidationError::EmptyMap);
    }

    let expected_len = usize::from(width) * usize::from(height);
    if pixels.len() != expected_len {
        return Err(ValidationError::DimensionMismatch {
            expected: expected_len,
            actual: pixels.len(),
        });
    }

    let mut has_floor = false;
    let mut walls = Vec::with_capacity(pixels.len());
    for (index, rgb) in pixels.iter().copied().enumerate() {
        let semantic = classify_rgb(rgb).ok_or_else(|| ValidationError::UnknownColor {
            coordinate: coordinate_for_index(index, width),
            rgb,
        })?;
        has_floor |= semantic == SemanticColor::Floor;
        walls.push(semantic == SemanticColor::Wall);
    }

    if !has_floor {
        return Err(ValidationError::MissingFloor);
    }

    Ok(ValidatedMap {
        width,
        height,
        walls,
    })
}

fn coordinate_for_index(index: usize, width: u16) -> Coordinate {
    let width = usize::from(width);
    Coordinate {
        x: (index % width) as u16,
        y: (index / width) as u16,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::maps::palette::{FLOOR, METRO, SPAWN_CYAN, SPAWN_MAGENTA, WALL};

    #[test]
    fn rejects_unknown_colors_with_coordinates() {
        let error = validate_pixels(
            3,
            2,
            &[
                FLOOR,
                FLOOR,
                FLOOR,
                SPAWN_MAGENTA,
                Rgb::new(1, 2, 3),
                SPAWN_CYAN,
            ],
        )
        .expect_err("unknown color should fail validation");
        assert_eq!(
            error,
            ValidationError::UnknownColor {
                coordinate: Coordinate { x: 1, y: 1 },
                rgb: Rgb::new(1, 2, 3)
            }
        );
    }

    #[test]
    fn compiles_collision_without_fixed_entity_counts() {
        let map = validate_pixels(3, 2, &[FLOOR, METRO, FLOOR, SPAWN_MAGENTA, WALL, FLOOR])
            .expect("valid semantic map");
        assert!(map.is_wall(1.0, 1.0));
        assert!(!map.is_wall(0.0, 0.0));
    }
}
