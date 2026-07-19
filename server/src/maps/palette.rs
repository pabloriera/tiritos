pub const PALETTE_VERSION: u16 = 2;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rgb {
    pub red: u8,
    pub green: u8,
    pub blue: u8,
}

impl Rgb {
    pub const fn new(red: u8, green: u8, blue: u8) -> Self {
        Self { red, green, blue }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SemanticColor {
    Floor,
    Wall,
    Spawn { group: char },
    Metro,
}

pub const FLOOR: Rgb = Rgb::new(128, 128, 0);
pub const WALL: Rgb = Rgb::new(128, 0, 0);
pub const METRO: Rgb = Rgb::new(0, 128, 255);
pub const SPAWN_MAGENTA: Rgb = Rgb::new(255, 0, 255);
pub const SPAWN_CYAN: Rgb = Rgb::new(128, 255, 255);
pub const SPAWN_VIOLET: Rgb = Rgb::new(64, 0, 255);

pub fn classify_rgb(rgb: Rgb) -> Option<SemanticColor> {
    match rgb {
        FLOOR => Some(SemanticColor::Floor),
        WALL => Some(SemanticColor::Wall),
        METRO => Some(SemanticColor::Metro),
        SPAWN_MAGENTA => Some(SemanticColor::Spawn { group: 'M' }),
        SPAWN_CYAN => Some(SemanticColor::Spawn { group: 'C' }),
        SPAWN_VIOLET => Some(SemanticColor::Spawn { group: 'V' }),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_level_one_palette() {
        assert_eq!(classify_rgb(FLOOR), Some(SemanticColor::Floor));
        assert_eq!(classify_rgb(WALL), Some(SemanticColor::Wall));
        assert_eq!(classify_rgb(METRO), Some(SemanticColor::Metro));
        assert_eq!(
            classify_rgb(SPAWN_VIOLET),
            Some(SemanticColor::Spawn { group: 'V' })
        );
    }

    #[test]
    fn rejects_legacy_and_approximate_colors() {
        assert_eq!(classify_rgb(Rgb::new(255, 255, 255)), None);
        assert_eq!(classify_rgb(Rgb::new(127, 128, 0)), None);
    }
}
