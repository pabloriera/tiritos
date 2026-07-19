use std::io::Cursor;

use png::{BitDepth, ColorType, Decoder, Transformations};

use super::{
    palette::Rgb,
    validator::{ValidatedMap, ValidationError, validate_pixels},
};

#[derive(Debug, PartialEq, Eq)]
pub enum DecodeError {
    Png(String),
    UnsupportedFormat {
        color_type: String,
        bit_depth: String,
    },
    Validation(ValidationError),
}

pub fn decode_and_validate_png(bytes: &[u8]) -> Result<ValidatedMap, DecodeError> {
    let mut decoder = Decoder::new(Cursor::new(bytes));
    decoder.set_transformations(Transformations::EXPAND | Transformations::STRIP_16);
    let mut reader = decoder
        .read_info()
        .map_err(|error| DecodeError::Png(error.to_string()))?;

    let mut buffer = vec![0; reader.output_buffer_size()];
    let output = reader
        .next_frame(&mut buffer)
        .map_err(|error| DecodeError::Png(error.to_string()))?;
    let bytes = &buffer[..output.buffer_size()];
    if output.color_type != ColorType::Rgb || output.bit_depth != BitDepth::Eight {
        return Err(DecodeError::UnsupportedFormat {
            color_type: format!("{:?}", output.color_type),
            bit_depth: format!("{:?}", output.bit_depth),
        });
    }
    let pixels = bytes
        .chunks_exact(3)
        .map(|chunk| Rgb::new(chunk[0], chunk[1], chunk[2]))
        .collect::<Vec<_>>();

    validate_pixels(output.width as u16, output.height as u16, &pixels)
        .map_err(DecodeError::Validation)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_and_validates_builtin_maps() {
        for (name, bytes) in [
            (
                "level1",
                include_bytes!("../../../maps/builtin/level1/map.png").as_slice(),
            ),
            (
                "switchback-basin",
                include_bytes!("../../../maps/builtin/switchback-basin/map.png").as_slice(),
            ),
            (
                "clover-junction",
                include_bytes!("../../../maps/builtin/clover-junction/map.png").as_slice(),
            ),
        ] {
            let map =
                decode_and_validate_png(bytes).expect("builtin map should decode and validate");

            assert_eq!(map.width, 1552, "{name} width");
            assert_eq!(map.height, 783, "{name} height");
        }
    }
}
