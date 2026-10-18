/*
 * SPDX-FileCopyrightText: 2026 M5Stack Technology CO LTD
 *
 * SPDX-License-Identifier: MIT
 */
#ifndef __M5_PY32IOEXPANDER_CLASS_H__
#define __M5_PY32IOEXPANDER_CLASS_H__

#include <M5Unified.hpp>

namespace m5 {
class PY32IOExpander_Class : public I2C_Device {
public:
    static constexpr std::uint8_t DEFAULT_ADDRESS = 0x6F;

    PY32IOExpander_Class(std::uint8_t i2c_addr = DEFAULT_ADDRESS, std::uint32_t freq = 100000,
                         m5::I2C_Class* i2c = &m5::In_I2C)
        : I2C_Device(i2c_addr, freq, i2c)
    {
    }

    bool begin();

    // IOExpander_Bases
    // false input, true output
    void setDirection(uint8_t pin, bool direction);

    void enablePull(uint8_t pin, bool enablePull);

    // false down, true up
    void setPullMode(uint8_t pin, bool mode);

    // false push-pull, true open-drain
    void setDriveMode(uint8_t pin, bool openDrain);

    void setHighImpedance(uint8_t pin, bool enable);

    bool getWriteValue(uint8_t pin);

    void digitalWrite(uint8_t pin, bool level);

    bool digitalRead(uint8_t pin);

    void resetIrq();

    void disableIrq();

    void enableIrq();

    // Extended functionality
    uint16_t readDeviceUID();
    uint8_t readVersion();

    // ADC
    // channel: 1-4
    uint16_t analogRead(uint8_t channel);

    // PWM
    // channel: 0-3
    void setPwmDuty(uint8_t channel, uint8_t duty);
    void setPwmFrequency(uint16_t freq);

    // LED
    void setLedCount(uint8_t count);
    void setLedColor(uint8_t index, uint16_t color565);
    void setLedColor(uint8_t index, uint8_t r, uint8_t g, uint8_t b);
    void setLedColor(uint8_t index, uint32_t color);
    void setLedData(const uint8_t* data, size_t len);
    void refreshLeds();

private:
    void _writeBit(uint8_t reg_l, uint8_t reg_h, uint8_t pin, bool value);
    bool _readBit(uint8_t reg_l, uint8_t reg_h, uint8_t pin);
};
}  // namespace m5

#endif
