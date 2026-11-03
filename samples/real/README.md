# Real public datasets

Used by `apps/server/eval` to test Reality on real, messy data. Files are unchanged copies.

| File             | Source                                                                                                                                                                                                                    | License                                                      | Retrieved |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | --------- |
| `co2_mm_mlo.csv` | NOAA Global Monitoring Laboratory, Mauna Loa CO₂ monthly mean data, <https://gml.noaa.gov/ccgg/trends/data.html> (Dr. Xin Lan, NOAA/GML, and Dr. Ralph Keeling, Scripps Institution of Oceanography)                      | Public domain (U.S. Government work; NOAA asks for citation) | 2026      |
| `bike_day.csv`   | `day.csv` of the UCI Bike Sharing Dataset, Fanaee-T, H. & Gama, J. (2013), _Event labeling combining ensemble detectors and background knowledge_, Progress in Artificial Intelligence; <https://doi.org/10.24432/C5W894> | CC BY 4.0                                                    | 2026      |

What makes them realistic:

- **CO₂:** 40 comment lines before the header, no date column (`year` and `month`), no-data markers (`-9.99`, `-0.99`, `-1`), 68 years of monthly values.
- **Bike Sharing:** two years of daily values (so only two yearly cycles), categories coded as integers (`season`, `weathersit`), a running row number (`instant`).
