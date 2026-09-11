# Weather Display MQTT publisher.
# Classifies the next 24 hours into
#   (temp_bucket, cond_code, is_night, precip_bucket, wind_bucket, temperature_f)
# and publishes them. The FastLED firmware owns the palette, so this script
# never touches RGB values. Raw °F enables continuous temperature colors.
#
# Payload: {"h":[[temp_bucket, cond_code, is_night, precip_bucket, wind_bucket, temperature_f], ... 24 entries]}
# is_night is 0/1. The firmware applies a brightness dim when set so
# partlycloudy/cloudy nights don't whitewash the strip.
#
# precip_bucket (0..10): 0 = no data. Buckets 1-3 / 4-7 / 8-10 select
# light / medium / heavy wet colors on rain, snow and sleet hours.
# Sourced from precipitation_probability (percent) when present,
# else falls back to precipitation (amount, converted to mm).
#
# wind_bucket (0..8): 0 = no data. Scales wind shimmer amplitude on the
# firmware side. Wind speed is normalized to mph from the weather entity's
# wind_speed_unit before bucketing.
#
# Older retained payloads may still be 3-tuples -- the firmware handles both.
#
# Only the condition strings HA weather integrations actually emit are mapped.
# Any unknown string falls through to code 0 (unknown).
#
# Keep enums in sync with src/main.cpp on the device.

# Condition code map (keep in sync with COND_* enum in firmware).
COND_MAP = {
    'sunny':            1,
    'clear-night':      2,
    'partlycloudy':     3,
    'cloudy':           4,
    'windy':            5,
    'windy-variant':    6,
    'fog':              7,
    'rainy':            8,
    'pouring':          8,   # heavy rain -- same look as rainy
    'snowy':            9,
    'snowy-rainy':     10,
    'lightning-rainy': 11,
    'lightning':       11,   # dry thunder -- same look as lightning-rainy
    'hail':            13,   # frozen mix, shares the sleet color
    'exceptional':     12,
}

def temperature_f(value, unit):
    try:
        t = float(value)
    except (TypeError, ValueError):
        return None
    # Reject NaN/infinity so the MQTT payload remains valid JSON.
    if t != t or t == float('inf') or t == -float('inf'):
        return None
    if unit == '°C':
        return t * 1.8 + 32
    return t

def temp_bucket(t):
    if t is None:
        return 0
    if t < 20:  return 1
    if t < 32:  return 2
    if t < 50:  return 3
    if t < 65:  return 4
    if t < 78:  return 5
    if t < 90:  return 6
    return 7

# Precip / wind bucketers.

def precip_bucket_pct(pct):
    # Probability percent (0..100) -> 10 even bands. None / negative /
    # non-numeric -> 0 ("no data"). 0% still lights bucket 1: 0% is a valid
    # forecast value, not missing data. Bands: 0-9->1, 10-19->2, ..., 90-100->10.
    if pct is None:
        return 0
    try:
        p = float(pct)
    except (TypeError, ValueError):
        return 0
    if p < 0:
        return 0
    b = int(p // 10) + 1
    if b < 1:  b = 1
    if b > 10: b = 10
    return b

def precip_bucket_mm(mm):
    # Amount: dry = 1, trace (<0.1 mm) = 2, then split at 0.5/1/2/4/8/16/32.
    # None / negative / non-numeric -> 0. 0.0 mm lights bucket 1 (dry-but-present).
    if mm is None:
        return 0
    try:
        m = float(mm)
    except (TypeError, ValueError):
        return 0
    if m < 0:     return 0
    if m == 0:    return 1
    if m < 0.1:   return 2
    if m < 0.5:   return 3
    if m < 1.0:   return 4
    if m < 2.0:   return 5
    if m < 4.0:   return 6
    if m < 8.0:   return 7
    if m < 16.0:  return 8
    if m < 32.0:  return 9
    return 10

def wind_bucket_mph(mph):
    # Wind speed in mph -> 8 bands. None / negative / non-numeric -> 0 (no data).
    # Bands: 0-<5->1, 5-9->2, 10-14->3, 15-19->4, 20-29->5, 30-39->6, 40-49->7, >=50->8.
    if mph is None:
        return 0
    try:
        w = float(mph)
    except (TypeError, ValueError):
        return 0
    if w < 0:     return 0
    if w < 5:     return 1
    if w < 10:   return 2
    if w < 15:   return 3
    if w < 20:   return 4
    if w < 30:   return 5
    if w < 40:   return 6
    if w < 50:   return 7
    return 8

# Wind speed unit -> mph multiplier. Applied to per-hour wind_speed before
# bucketing. Missing / unknown unit defaults to mph with a warning.
WIND_TO_MPH = {
    'mph':  1.0,
    'km/h': 0.621371,
    'm/s':  2.23694,
    'kn':   1.15078,
    'ft/s': 0.681818,
}

# Precip amount unit -> mm multiplier.
PRECIP_TO_MM = {
    'mm': 1.0,
    'cm': 10.0,
    'in': 25.4,
}

# Local-time UTC offset in hours (negative west of UTC). Uses HA's now(), which
# is timezone-aware in the configured local timezone, so DST is handled.
# Edit FALLBACK_UTC_OFFSET to your zone; it is only used if now() fails.
FALLBACK_UTC_OFFSET = -6

def local_utc_offset_hours():
    try:
        local_dt = now()
        offset_td = local_dt.utcoffset()
        if offset_td is not None:
            hours = offset_td.total_seconds() / 3600
            return int(hours)
    except Exception as e:
        logger.warning("local_utc_offset_hours: failed to extract offset from now(): " + str(e))

    logger.warning("local_utc_offset_hours: using hardcoded fallback " + str(FALLBACK_UTC_OFFSET))
    return FALLBACK_UTC_OFFSET

def is_night_hour(forecast_dt_str, offset_hours):
    # forecast_dt_str looks like '2026-06-09T03:00:00+00:00' (UTC).
    # Take the hour substring (chars 11..13), apply the offset, wrap to 0..23.
    try:
        h_utc = int(forecast_dt_str[11:13])
    except Exception:
        return 0
    h_local = (h_utc + offset_hours) % 24
    # Night band: 20:00 -- 06:59 local. Conservative -- this is meant to make
    # cloudy/partlycloudy nights read as "night", not a precise civil-twilight
    # boundary. Most integrations already emit clear-night for clear hours.
    if h_local >= 20 or h_local < 7:
        return 1
    return 0

forecast_data = data.get('forecast_data')
if not forecast_data:
    logger.warning("weather_display_publish: no forecast_data provided")
else:
    forecast_list = None
    forecast_entity_id = None
    for entity_id in forecast_data:
        ed = forecast_data[entity_id]
        try:
            fc = ed.get('forecast')
        except AttributeError:
            fc = None
        if fc:
            forecast_list = fc
            forecast_entity_id = entity_id
            break

    if not forecast_list:
        logger.warning("weather_display_publish: empty forecast")
    else:
        # Look up the weather entity's declared units so we can normalize
        # wind (-> mph) and precip amount (-> mm) before bucketing.
        temp_unit = '°F'
        wind_scale = 1.0
        precip_scale = 1.0
        try:
            st = hass.states.get(forecast_entity_id)
            if st is not None:
                temp_unit = st.attributes.get('temperature_unit') or '°F'
                w_unit = st.attributes.get('wind_speed_unit')
                p_unit = st.attributes.get('precipitation_unit')
                if w_unit in WIND_TO_MPH:
                    wind_scale = WIND_TO_MPH[w_unit]
                elif w_unit:
                    logger.warning("weather_display_publish: unknown wind_speed_unit '" + str(w_unit) + "', assuming mph")
                if p_unit in PRECIP_TO_MM:
                    precip_scale = PRECIP_TO_MM[p_unit]
                elif p_unit:
                    logger.warning("weather_display_publish: unknown precipitation_unit '" + str(p_unit) + "', assuming mm")
        except Exception as e:
            logger.warning("weather_display_publish: unit lookup failed: " + str(e))

        hours = []
        for h in forecast_list[:24]:
            hours.append(h)
        while len(hours) > 0 and len(hours) < 24:
            hours.append(hours[-1])

        if len(hours) < 24:
            logger.warning("weather_display_publish: forecast empty after slicing")
        else:
            offset = local_utc_offset_hours()
            out = []
            for h in hours:
                t = temperature_f(h.get('temperature'), temp_unit)
                cond_str = h.get('condition') or ''
                dt_str = h.get('datetime') or ''
                bucket = temp_bucket(t)
                code = COND_MAP.get(cond_str, 0)
                night = 1 if cond_str == 'clear-night' else is_night_hour(dt_str, offset)

                # Precip: prefer probability, fall back to amount in mm.
                pop = h.get('precipitation_probability')
                if pop is not None:
                    pb = precip_bucket_pct(pop)
                else:
                    amt = h.get('precipitation')
                    if amt is not None:
                        try:
                            pb = precip_bucket_mm(float(amt) * precip_scale)
                        except (TypeError, ValueError):
                            pb = 0
                    else:
                        pb = 0

                # Wind: normalize to mph, then bucket.
                ws = h.get('wind_speed')
                if ws is not None:
                    try:
                        wb = wind_bucket_mph(float(ws) * wind_scale)
                    except (TypeError, ValueError):
                        wb = 0
                else:
                    wb = 0

                out.append([bucket, code, night, pb, wb, t])

            entry_strs = []
            for e in out:
                entry_strs.append(
                    '[' + str(e[0]) + ',' + str(e[1]) + ',' + str(e[2])
                    + ',' + str(e[3]) + ',' + str(e[4])
                    + ',' + ('null' if e[5] is None else str(e[5])) + ']'
                )
            payload = '{"h":[' + ','.join(entry_strs) + ']}'
            try:
                # Ensure the device is in forecast mode every refresh. Retained,
                # so it also pulls the strip out of demo after a reboot.
                hass.services.call('mqtt', 'publish', {
                    'topic': 'weather/display/mode',
                    'payload': 'forecast',
                    'qos': 0,
                    'retain': True,
                }, True)
                hass.services.call('mqtt', 'publish', {
                    'topic': 'weather/hourly',
                    'payload': payload,
                    'qos': 0,
                    'retain': True,
                }, True)
                logger.info("weather_display_publish: published " + str(len(out)) + " hours")
            except Exception as e:
                logger.warning("weather_display_publish: mqtt publish failed: " + str(e))
