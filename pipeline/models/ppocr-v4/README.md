PP-OCRv4 mobile detection + recognition (ONNX), from PaddleOCR (Apache-2.0), as packaged in @gutenye/ocr-models.
- det.onnx  ch_PP-OCRv4_det_infer
- rec.onnx  ch_PP-OCRv4_rec_infer (Chinese+English dictionary; drops some spaces in Latin text -> lib/segment.ts repairs)
- dict.txt  ppocr_keys_v1.txt

To upgrade: put an English/Latin PP-OCRv5 rec model here (or in another folder and set OCR_MODEL_DIR) using the same
three file names. No code change needed.
