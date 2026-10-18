/*
 * SPDX-FileCopyrightText: 2026 M5Stack Technology CO LTD
 *
 * SPDX-License-Identifier: MIT
 */
#pragma once
#include "../../drivers/Si12T/Si12T.h"
#include <Arduino.h>
#include <memory>

namespace m5 {

class TouchSensor_Class : public Button_Class {
public:
    void begin();
    void update();

    /**
     * @brief Get the intensitiy values for three channels,
     * index 0, 1, and 2 correspond to the Front, Middle, and Back physical zones respectively.
     * Each channel's value ranges from 0 to 3, where 0 indicates no touch (idle) and 1–3 represent increasing levels of
     * touch intensity.
     *
     * @return const std::array<uint8_t, 3>&
     */
    inline const std::array<uint8_t, 3>& getIntensities() const
    {
        return _intensities;
    }

    /**
     * @brief Was swipe gesture detected.
     *
     * @return true
     * @return false
     */
    bool wasSwiped();

    /**
     * @brief Was swipe forward gesture (Front to back) detected.
     *
     * @return true
     * @return false
     */
    bool wasSwipedForward();

    /**
     * @brief Was swipe backward gesture (Back to front) detected.
     *
     * @return true
     * @return false
     */
    bool wasSwipedBackward();

private:
    std::unique_ptr<Si12T> _touch_sensor;
    std::array<uint8_t, 3> _intensities;

    enum class SwipeDir { None, Forward, Backward };
    SwipeDir _swipe_result;
    uint32_t _touch_start_time[3];
    bool _touched_flag[3];
    bool _in_gesture;
    uint32_t _last_touched_time;

    void update_gesture();
};

}  // namespace m5
